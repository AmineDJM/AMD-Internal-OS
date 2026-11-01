"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { anyRoleFilter, userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { broadcastNotification } from "@/lib/notify";
import { companyScopedWhere } from "@/lib/company";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { toNumber } from "@/lib/utils";
import {
  jourAlger, estEtatLigne, etatDemande, lireReponse, phraseBilan, type EtatLigne, type SaisieLigne,
} from "@/modules/finances/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉPONDRE À UNE DEMANDE D'ACTUALISATION DES SOLDES — depuis la notification (Direction, 10/2026).
 *
 * Le responsable Finance clique la notification, l'écran de la demande s'ouvre, il saisit pour CHAQUE
 * compte le solde du nouveau relevé et sa date — ou « pas encore reçu ». Le compte est RÉANCRÉ
 * (le même effet que « Corriger l'ancrage », l'ancien et le nouvel ancrage gardés à l'audit), puis
 * celui qui a demandé et les Super Admins sont prévenus, avec le bilan compte par compte.
 *
 * Gardes : le droit de MODIFIER les Finances (celui qui ancre un compte à l'écran), et la VUE du
 * compte (son entité) — on ne réancre pas un compte qu'on ne voit pas. La règle (réponse complète,
 * date ni future ni antérieure au relevé actuel, compte actualisé définitif) est dans le module pur
 * `lib/finance/actualisation-soldes.ts`, lu aussi par l'écran.
 *
 * L'écriture d'une ligne est CONDITIONNELLE (« pas encore actualisée ») : deux comptables qui
 * répondent ensemble ne réancrent pas deux fois le même compte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function repondreActualisationSoldes(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "FINANCES", "UPDATE")) return { ok: false, error: "Actualiser un solde demande le droit « Modifier » des Finances." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande non précisée." };

  // LES SAISIES arrivent en un seul champ JSON (une ligne par compte) : la liste des comptes dépend de
  // la demande, des noms de champs fabriqués ne se décriraient pas.
  let brut: unknown;
  try { brut = JSON.parse(fdStr(formData, "lignes") ?? "[]"); } catch { return { ok: false, error: "Saisie illisible : rechargez la page." }; }
  if (!Array.isArray(brut)) return { ok: false, error: "Saisie illisible : rechargez la page." };
  const saisies: SaisieLigne[] = brut.flatMap((x): SaisieLigne[] => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.ligneId !== "string" || (o.choix !== "ACTUALISE" && o.choix !== "NON_RECU")) return [];
    return [{
      ligneId: o.ligneId, choix: o.choix,
      solde: typeof o.solde === "number" ? o.solde : null,
      date: typeof o.date === "string" ? o.date : null,
    }];
  });

  const demande = await prisma.demandeActualisationSoldes.findUnique({
    where: { id },
    include: {
      company: { select: { name: true, shortName: true } },
      lignes: { include: { compte: { select: { id: true, name: true, openingBalance: true, openingDate: true } } }, orderBy: { compte: { name: "asc" } } },
    },
  });
  if (!demande) return { ok: false, error: "Demande introuvable." };
  if (demande.termineeLe) return { ok: false, error: "Cette demande est déjà entièrement actualisée." };

  // LA VUE DES COMPTES : chacun doit être visible de la personne (son entité).
  const visibles = new Set((await prisma.treasuryAccount.findMany({
    where: await companyScopedWhere(user.id, { id: { in: demande.lignes.map((l) => l.compteId) } }),
    select: { id: true },
  })).map((c) => c.id));
  if (demande.lignes.some((l) => !visibles.has(l.compteId))) return { ok: false, error: "Demande introuvable." };

  const lecture = lireReponse(
    demande.lignes.map((l) => ({
      id: l.id, compte: l.compte.name,
      etat: estEtatLigne(l.etat) ? l.etat : "EN_ATTENTE",
      jourAncrageActuel: jourAlger(l.compte.openingDate),
    })),
    saisies,
    jourAlger(new Date()),
  );
  if (!lecture.ok) return { ok: false, error: lecture.error };

  const maintenant = new Date();
  const parLigne = new Map(demande.lignes.map((l) => [l.id, l]));
  const faites: { compte: string; avant: string; apres: string }[] = [];

  const conflit = await prisma.$transaction(async (tx) => {
    for (const a of lecture.actualisees) {
      const l = parLigne.get(a.ligneId)!;
      const nouvelleDate = new Date(`${a.date}T00:00:00.000Z`);
      const posee = await tx.ligneActualisationSoldes.updateMany({
        where: { id: l.id, etat: { not: "ACTUALISE" } },
        data: { etat: "ACTUALISE", nouveauSolde: a.solde, nouvelleDate, traiteParId: user.id, traiteLe: maintenant },
      });
      if (posee.count === 0) return l.compte.name;
      await tx.treasuryAccount.update({ where: { id: l.compteId }, data: { openingBalance: a.solde, openingDate: nouvelleDate, updatedById: user.id } });
      faites.push({
        compte: l.compte.name,
        avant: `${toNumber(l.compte.openingBalance).toLocaleString("fr-FR")} DZD au ${jourAlger(l.compte.openingDate)}`,
        apres: `${a.solde.toLocaleString("fr-FR")} DZD au ${a.date}`,
      });
    }
    for (const ligneId of lecture.nonRecues) {
      await tx.ligneActualisationSoldes.updateMany({
        where: { id: ligneId, etat: { not: "ACTUALISE" } },
        data: { etat: "NON_RECU", traiteParId: user.id, traiteLe: maintenant },
      });
    }
    const etats = await tx.ligneActualisationSoldes.findMany({ where: { demandeId: id }, select: { etat: true } });
    if (etatDemande(etats.map((e) => (estEtatLigne(e.etat) ? e.etat : "EN_ATTENTE"))) === "TERMINEE") {
      await tx.demandeActualisationSoldes.update({ where: { id }, data: { termineeLe: maintenant } });
    }
    return null;
  });
  if (conflit) return { ok: false, error: `« ${conflit} » vient d'être actualisé par quelqu'un d'autre : rechargez la page.` };

  // L'AUDIT, compte par compte — l'ancien et le nouvel ancrage, comme « Corriger l'ancrage ».
  for (const f of faites) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Finances", field: "ancrage",
      oldValue: f.avant, newValue: f.apres,
      summary: `Solde du compte « ${f.compte} » actualisé à la demande — ${f.avant} → ${f.apres}`,
    });
  }

  // LE BILAN, relu après écriture : c'est lui qu'on annonce, pas ce qu'on espérait écrire.
  const relue = await prisma.ligneActualisationSoldes.findMany({
    where: { demandeId: id },
    select: { etat: true, nouveauSolde: true, nouvelleDate: true, compte: { select: { name: true } } },
    orderBy: { compte: { name: "asc" } },
  });
  const lignesBilan = relue.map((l) => ({
    compte: l.compte.name,
    etat: (estEtatLigne(l.etat) ? l.etat : "EN_ATTENTE") as EtatLigne,
    solde: l.nouveauSolde === null ? null : toNumber(l.nouveauSolde),
    date: l.nouvelleDate ? jourAlger(l.nouvelleDate) : null,
  }));
  const etat = etatDemande(lignesBilan.map((l) => l.etat));
  const nomEntite = demande.company ? demande.company.shortName || demande.company.name : "sans entité";
  const bilan = phraseBilan(lignesBilan);

  // LE RETOUR : celui qui a demandé, et les Super Admins (décision de la Direction) — une fois chacun.
  const supers = await prisma.user.findMany({ where: { ...anyRoleFilter(["SUPER_ADMIN"]), isActive: true }, select: { id: true } });
  await broadcastNotification({
    audience: "USERS",
    userIds: [demande.demandeParId, ...supers.map((s) => s.id)],
    title: `${etat === "TERMINEE" ? "Soldes actualisés" : "Soldes partiellement actualisés"} — ${nomEntite}`,
    body: `${bilan} — par ${user.name}.`,
    link: `/finances/paiements-a-faire${demande.companyId ? `?entite=${demande.companyId}` : ""}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Finances",
    summary: `Réponse à la demande d'actualisation des soldes — ${nomEntite} : ${bilan}`,
  });

  revalidatePath("/finances", "layout");
  return {
    ok: true, id,
    message: etat === "TERMINEE"
      ? `Soldes actualisés pour ${nomEntite}. Le demandeur et les Super Admins sont prévenus.`
      : `Réponse enregistrée pour ${nomEntite} — les comptes « pas encore reçu » restent à compléter depuis cette même demande. Le demandeur et les Super Admins sont prévenus.`,
  };
}
