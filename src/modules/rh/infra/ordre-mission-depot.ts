import { readFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/prisma";
import { putBlob } from "@/lib/drive-storage";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { nomOrdreMission, refusOrdreMission, remplirOrdreDeMission, type ChampsOrdreMission } from "./ordre-mission/modele";
import { synchroniserOrdreEmis } from "@/lib/missions-equipe/serveur";
import { refusTraitementRh } from "@/lib/missions-equipe/etat";
import { marquerDemandeRhTraitee } from "./hr-demande-traitee";
import { saisieEffective } from "@/lib/references/registre";
import { anneeDuRegistre, attribuerAuRegistre, registreDe } from "@/lib/references/registre-serveur";
import { sansBloquer } from "@/lib/journal";

/**
 * HORS DU DOMAINE RH, À DESSEIN (comme hr-drive-mirror.ts) : c'est l'orchestration qui touche au stockage (drive-storage)
 * — le domaine garde le modèle et ses règles (hr/ordre-mission/modele.ts), sans fournisseur.
 *
 * L'ORDRE DE MISSION GÉNÉRÉ ET REMIS AU SALARIÉ (Direction, 06/10) — côté serveur : lire le modèle, le remplir, et le déposer comme la pièce qui RÉPOND à la demande (même chemin que « Joindre le document & marquer prêt ») :
 * le PDF, visible du salarié (le Word reste aux RH) ; la demande passe « prête », le salarié est
 * prévenu.
 */
const CHEMIN_MODELE = join(process.cwd(), "src", "modules", "rh", "infra", "ordre-mission", "modele-ordre-de-mission.docx");
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const plier = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * LA SOCIÉTÉ QUI ÉMET L'ORDRE DE MISSION — celle que le document IMPRIME (le champ « Entreprise », « ADVENTUM PHARMA ») : la
 * référence NNN/DG/AAAA est celle de son registre. À défaut (un nom qui ne désigne aucune société), l'employeur du salarié.
 */
export async function societeDeLOrdreDeMission(requestId: string, entreprise: string | null | undefined): Promise<string | null> {
  const voulu = plier(entreprise ?? "");
  if (voulu) {
    const societes = await prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true, shortName: true } });
    const exacte = societes.filter((c) => plier(c.name) === voulu || (c.shortName && plier(c.shortName) === voulu));
    const proche = exacte.length ? exacte : societes.filter((c) => voulu.includes(plier(c.name)) || plier(c.name).includes(voulu));
    if (proche.length === 1) return proche[0].id;
  }
  const d = await prisma.hrDocumentRequest.findUnique({
    where: { id: requestId },
    select: { employee: { select: { companyId: true, departmentRef: { select: { companyId: true } } } } },
  });
  return d?.employee.companyId ?? d?.employee.departmentRef?.companyId ?? null;
}

/**
 * La référence proposée HORS REGISTRE (une société qui ne tient pas le registre NNN/DG/AAAA) : le numéro suivant de l'année,
 * au format historique du document de la Direction (« 007/DPG/2026 »). Au registre, le formulaire lit le prochain NNN/DG/AAAA.
 */
export async function referenceOrdreMissionSuggeree(maintenant = new Date()): Promise<string> {
  const annee = maintenant.getFullYear();
  const deja = await prisma.employeeDocument.count({
    // Un ordre = un Word (le PDF l'accompagne) : on compte les Word, pour ne pas compter chaque ordre deux fois.
    where: { name: { startsWith: "Ordre de mission " }, mime: MIME_DOCX, createdAt: { gte: new Date(Date.UTC(annee, 0, 1)) } },
  });
  return `${String(deja + 1).padStart(3, "0")}/DPG/${annee}`;
}

export async function genererEtRemettreOrdreDeMission(
  acteurId: string, requestId: string, saisis: ChampsOrdreMission,
  /** Le numéro que le formulaire avait prérempli : laissé tel quel, le registre attribue le prochain libre. */
  opts: { referenceSuggeree?: string | null } = {},
): Promise<{ ok: true; message: string; employeeId: string } | { ok: false; error: string }> {
  const demande = await prisma.hrDocumentRequest.findUnique({
    where: { id: requestId },
    select: { id: true, type: true, status: true, employeeId: true, managerGate: true, employee: { select: { fullName: true, userId: true } } },
  });
  if (!demande) return { ok: false, error: "Demande introuvable." };
  if (demande.type !== "MISSION_ORDER") return { ok: false, error: "Cette demande n'est pas un ordre de mission." };
  if (demande.status === "CANCELLED") return { ok: false, error: "Cette demande est annulée." };
  // LA MARCHE DU N+1 PASSE AVANT LES RH (Direction, 10/2026) : un ordre encore chez le N+1, ou refusé par lui, ne se produit pas.
  const avantRh = refusTraitementRh(demande.managerGate ?? null);
  if (avantRh) return { ok: false, error: avantRh };
  // LE REGISTRE COMMUN NNN/DG/AAAA (Direction, 10/2026) de la société qui émet : la référence est attribuée ICI, au moment de
  // produire l'ordre — la saisie si elle a été modifiée (vérifiée : libre pour la société et l'année, tous documents
  // confondus), sinon le prochain numéro libre. Hors registre, la référence saisie est imprimée telle quelle (« 007/DPG/2026 »).
  const societeId = await societeDeLOrdreDeMission(requestId, saisis.entreprise);
  const annee = anneeDuRegistre();
  const registre = await registreDe(societeId, annee);
  const auRegistre = registre.actif && societeId !== null;
  const refus = refusOrdreMission(auRegistre && !saisis.reference.trim() ? { ...saisis, reference: "—" } : saisis);
  if (refus) return { ok: false, error: refus };
  let champs = saisis;
  if (auRegistre) {
    const r = await attribuerAuRegistre({
      companyId: societeId, annee, docType: "ORDRE_MISSION", entityType: "HR_REQUEST", entityId: requestId, createdById: acteurId,
      saisie: saisieEffective(saisis.reference, opts.referenceSuggeree),
    });
    if (!r.ok) return { ok: false, error: r.motif };
    champs = { ...saisis, reference: r.reference };
  }

  const docx = await remplirOrdreDeMission(await readFile(CHEMIN_MODELE), champs);
  const nom = nomOrdreMission(champs.reference, champs.collaborateur);
  // LE PDF EST LA PIÈCE REMISE (Direction, 06/10 : « améliore le convertisseur en top qualité ») : le moteur de mise en page
  // reproduit le document à l'identique (en-tête, logo, pied, tabulations — vérifié contre l'export de Word). Le Word est
  // gardé par les RH pour une retouche ; sans PDF (conversion impossible), c'est le Word qui est remis — et la phrase le dit.
  const pdf = await docxToPdf(docx).catch(sansBloquer("ordre-mission-depot.genererEtRemettreOrdreDeMission.docxToPdf", { ok: false as const, error: "conversion impossible" }));
  const w = await putBlob(docx);
  await prisma.employeeDocument.create({
    data: {
      employeeId: demande.employeeId, category: "OTHER", name: `${nom}.docx`, blobId: w.blobId, mime: MIME_DOCX, size: w.size,
      visibleToEmployee: !pdf.ok, uploadedById: acteurId, requestId: pdf.ok ? undefined : requestId,
    },
  });
  if (pdf.ok) {
    const p = await putBlob(pdf.pdf);
    await prisma.employeeDocument.create({
      data: {
        employeeId: demande.employeeId, category: "OTHER", name: `${nom}.pdf`, blobId: p.blobId, mime: "application/pdf", size: p.size,
        visibleToEmployee: true, uploadedById: acteurId, requestId,
      },
    });
  }
  await prisma.hrDocumentRequest.update({ where: { id: requestId }, data: { status: "READY", handledById: acteurId } });
  await marquerDemandeRhTraitee(requestId); // brique KPI « demandes traitées »
  // La mission Ad & Pro reliée passe « ordre émis » — le PDF paraît aussi dans « Mes missions ».
  await synchroniserOrdreEmis(requestId, acteurId);
  if (demande.employee.userId) {
    await notifyUser({ userId: demande.employee.userId, type: "GENERIC", title: "Votre ordre de mission est prêt", body: `N° ${champs.reference}`, link: `/mon-dossier#demande-rh-${requestId}` }).catch(sansBloquer("ordre-mission-depot.genererEtRemettreOrdreDeMission.notifyUser"));
  }
  await recordAudit({
    actorId: acteurId, action: "CREATE", module: "RH", entityType: "EMPLOYEE", entityId: demande.employeeId,
    summary: `Ordre de mission N° ${champs.reference} généré pour ${demande.employee.fullName} — ${champs.destination.replace(/\s+/g, " ")}`,
  });
  return {
    ok: true, employeeId: demande.employeeId,
    message: pdf.ok
      ? `Ordre de mission N° ${champs.reference} généré et remis à ${demande.employee.fullName} en PDF (le Word reste aux RH) — il le retrouve dans « Mon dossier RH ».`
      : `Ordre de mission N° ${champs.reference} généré et remis à ${demande.employee.fullName} en Word — le PDF n'a pas pu être produit (${pdf.error}).`,
  };
}
