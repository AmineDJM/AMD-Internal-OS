"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { peutAnnuaire } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { reposerWilayaCode } from "@/modules/lieux/api";
import { recordAudit } from "@/lib/audit";
import { doubleEcrireOrganisation } from "@/modules/referentiels/api";
import { fdStr, fdCase, type ActionResult } from "@/lib/actions/types";
import { actionReversible } from "@/lib/effets/reversible";
import { updateDoctor, updateInstitution } from "@/lib/actions/medical-actions";
import { CHAMPS_LOT, type CibleLot, type CompteRenduLot, type GroupeFusion, type LigneLot } from "@/lib/annuaires/lot";

/**
 * L'ANNUAIRE « FOURNISSEURS REGULATORY » (Direction, 06/10) — les fabricants des dossiers d'enregistrement, tenus
 * comme les autres annuaires : ajouter, corriger, retirer. C'est la MÊME fiche (`Supplier`) que les dossiers et le
 * portail externe : jamais une copie. Un fournisseur qui porte des dossiers ou des comptes du portail ne se supprime
 * pas — il se désactive, pour que ses dossiers gardent leur fabricant.
 */

const PATHS = ["/annuaires/fournisseurs", "/admin/suppliers"] as const;
const revalider = () => { for (const p of PATHS) revalidatePath(p); };

function lire(fd: FormData) {
  return {
    name: (fdStr(fd, "name") ?? "").replace(/\s+/g, " ").trim(),
    country: fdStr(fd, "country") || null,
    contactName: fdStr(fd, "contactName") || null,
    contactEmail: fdStr(fd, "contactEmail")?.toLowerCase() || null,
    phone: fdStr(fd, "phone") || null,
    website: fdStr(fd, "website") || null,
    address: fdStr(fd, "address") || null,
    city: fdStr(fd, "city") || null,
    notes: fdStr(fd, "notes") || null,
  };
}

export async function creerFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "CREATE")) return { ok: false, error: "Non autorisé (Regulatory, ou accès ouvert depuis la console)." };
  const data = lire(fd);
  if (!data.name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  const doublon = await prisma.supplier.findFirst({ where: { name: { equals: data.name, mode: "insensitive" } }, select: { id: true } });
  if (doublon) return { ok: false, error: `« ${data.name} » existe déjà dans l'annuaire des fournisseurs.` };
  const s = await prisma.supplier.create({ data: { ...data, createdById: user.id }, select: { id: true } });
  await reposerWilayaCode("Supplier", s.id); // double écriture des lieux (refonte V2-D) : ville + pays → wilaya
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Annuaires", entityType: "SUPPLIER", entityId: s.id, summary: `Fournisseur Regulatory « ${data.name} » ajouté` });
  await doubleEcrireOrganisation("SUPPLIER", s.id, user.id);
  revalider();
  return { ok: true, id: s.id };
}

export async function modifierFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(fd, "id");
  if (!id) return { ok: false, error: "Fournisseur introuvable." };
  const avant = await prisma.supplier.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Fournisseur introuvable." };
  // SEULEMENT CE QUE LE FORMULAIRE PORTE (lot T2, la règle de `updateInstitution`, §118.172) : un appelant qui corrige
  // UN champ (« le site web d'Hetero Labs ») ne doit ni effacer les autres, ni être refusé faute de nom.
  const lu = lire(fd);
  if (fd.has("name") && !lu.name) return { ok: false, error: "Le nom du fournisseur est obligatoire." };
  const data = {
    name: fd.has("name") ? lu.name : avant.name,
    ...(fd.has("country") ? { country: lu.country } : {}),
    ...(fd.has("contactName") ? { contactName: lu.contactName } : {}),
    ...(fd.has("contactEmail") ? { contactEmail: lu.contactEmail } : {}),
    ...(fd.has("phone") ? { phone: lu.phone } : {}),
    ...(fd.has("website") ? { website: lu.website } : {}),
    ...(fd.has("address") ? { address: lu.address } : {}),
    ...(fd.has("city") ? { city: lu.city } : {}),
    ...(fd.has("notes") ? { notes: lu.notes } : {}),
  };
  // La case « Actif » a un témoin caché : `fdCase` la lit (cochée, décochée, ou absente du formulaire).
  const actif = fdCase(fd, "active");
  await prisma.supplier.update({ where: { id }, data: { ...data, ...(actif !== undefined ? { active: actif } : {}) } });
  await reposerWilayaCode("Supplier", id); // double écriture des lieux (refonte V2-D)
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${avant.name}${data.name !== avant.name ? ` → ${data.name}` : ""} » corrigé` });
  revalider();
  return { ok: true };
}

/** Retire un fournisseur — supprimé s'il ne porte rien, sinon désactivé (ses dossiers gardent leur fabricant). */
export async function retirerFournisseurAnnuaire(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "FOURNISSEURS", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(fd, "id");
  if (!id) return { ok: false, error: "Fournisseur introuvable." };
  const s = await prisma.supplier.findUnique({ where: { id }, select: { name: true, _count: { select: { products: true, users: true } } } });
  if (!s) return { ok: false, error: "Fournisseur introuvable." };
  if (s._count.products + s._count.users > 0) {
    await prisma.supplier.update({ where: { id }, data: { active: false } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${s.name} » désactivé (${s._count.products} dossier(s), ${s._count.users} compte(s) portail)` });
    revalider();
    return { ok: true, message: `« ${s.name} » porte ${s._count.products} dossier(s) et ${s._count.users} compte(s) du portail : il est désactivé, pas supprimé.` };
  }
  await prisma.supplier.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Annuaires", entityType: "SUPPLIER", entityId: id, summary: `Fournisseur Regulatory « ${s.name} » supprimé` });
  revalider();
  return { ok: true };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNUAIRE TENU EN LOT (lot T2, décision 0052) — rangé ici, avec les actions des annuaires, pour ne pas ajouter un fichier
 * d'actions hors carte (cliquet `platform/couverture.test.ts`) — « mets à jour 300 fiches depuis cet Excel », « nettoie les doublons
 * des pharmacies d'Oran ». Deux actions de l'ERP, chacune UN SEUL GESTE réversible (`actionReversible`) : le lot entier
 * s'annule d'un coup, et chaque ligne passe par L'ACTION DE L'ÉCRAN qui la garde (`updateDoctor` : la portée du délégué,
 * `canAccessEntity` ; `updateInstitution`, `modifierFournisseurAnnuaire` : `peutAnnuaire`) — jamais un chemin parallèle. Une ligne refusée n'arrête pas
 * le lot : le compte rendu la nomme, avec sa raison.
 *
 *   • `appliquerLotAnnuaire`        — `lignes` (JSON) : [{ cible: "medecin" | "etablissement" | "fournisseur", id, champs }] ;
 *   • `fusionnerEtablissementsAnnuaire` — `groupes` (JSON) : [{ garder, absorber: [ids] }] : la fiche gardée reçoit les
 *     coordonnées qui lui manquent, les praticiens et les secteurs des fiches absorbées ; celles-ci sont DÉSACTIVÉES (jamais
 *     supprimées : leurs demandes de stock et leurs ventes gardent leur établissement), avec la trace de la fusion.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LOT_MAX = 500;

function lireJson<T>(brut: string | null): T | null {
  try { return JSON.parse(brut ?? "null") as T; } catch { return null; }
}

export async function appliquerLotAnnuaire(fd: FormData): Promise<ActionResult & { compte?: CompteRenduLot }> {
  return actionReversible("fournisseurs-annuaire-actions:appliquerLotAnnuaire", "Annuaire mis à jour en lot", async () => {
    const user = await requireUser();
    const lignes = lireJson<LigneLot[]>(fdStr(fd, "lignes"));
    if (!Array.isArray(lignes) || !lignes.length) return { ok: false, error: "Aucune ligne à appliquer." };
    if (lignes.length > LOT_MAX) return { ok: false, error: `Un lot porte au plus ${LOT_MAX} fiches : découpez-le.` };
    const compte: CompteRenduLot = { faites: 0, refusees: [] };
    for (const l of lignes) {
      const formulaire = CHAMPS_LOT[l.cible as CibleLot];
      if (!formulaire || typeof l.id !== "string") { compte.refusees.push({ id: String(l.id), raison: "ligne illisible" }); continue; }
      const f = new FormData();
      f.set("id", l.id);
      for (const [champ, valeur] of Object.entries(l.champs ?? {})) {
        const cle = (formulaire as Record<string, string>)[champ];
        if (!cle) { compte.refusees.push({ id: l.id, raison: `champ « ${champ} » non modifiable en lot` }); continue; }
        f.set(cle, valeur ?? "");
      }
      // L'ACTION DE L'ÉCRAN, qui rejuge le droit sur CETTE fiche (le panel du délégué, l'annuaire ouvert…).
      const r = l.cible === "medecin" ? await updateDoctor(f) : l.cible === "fournisseur" ? await modifierFournisseurAnnuaire(f) : await updateInstitution(f);
      if (r.ok) compte.faites += 1;
      else compte.refusees.push({ id: l.id, raison: r.error ?? "refusée" });
    }
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "INSTITUTION", entityId: user.id, summary: `Annuaire — mise à jour en lot : ${compte.faites} fiche(s), ${compte.refusees.length} refusée(s)` });
    revalidatePath("/medical");
    if (!compte.faites) return { ok: false, error: `Aucune fiche mise à jour : ${compte.refusees.map((x) => x.raison).slice(0, 3).join(" ; ")}`, compte };
    return { ok: true, compte };
  });
}

const COORDONNEES = ["phone", "email", "address", "region", "wilaya"] as const;

export async function fusionnerEtablissementsAnnuaire(fd: FormData): Promise<ActionResult & { fusionnees?: number }> {
  return actionReversible("fournisseurs-annuaire-actions:fusionnerEtablissementsAnnuaire", "Doublons d'établissements fusionnés", async () => {
    const user = await requireUser();
    if (!peutAnnuaire(user, "ETABLISSEMENTS", "UPDATE") && !peutAnnuaire(user, "PHARMACIENS", "UPDATE")) return { ok: false, error: "Non autorisé." };
    const groupes = lireJson<GroupeFusion[]>(fdStr(fd, "groupes"));
    if (!Array.isArray(groupes) || !groupes.length) return { ok: false, error: "Aucun groupe de doublons." };
    if (groupes.length > LOT_MAX) return { ok: false, error: `Au plus ${LOT_MAX} groupes par lot.` };
    let fusionnees = 0;
    for (const g of groupes) {
      const absorber = [...new Set((g.absorber ?? []).filter((x) => typeof x === "string" && x !== g.garder))];
      if (!g.garder || !absorber.length) continue;
      const fiches = await prisma.medicalInstitution.findMany({ where: { id: { in: [g.garder, ...absorber] } } });
      const garde = fiches.find((f) => f.id === g.garder);
      const autres = fiches.filter((f) => f.id !== g.garder && f.isActive);
      if (!garde || !autres.length) continue;
      // 1. Les coordonnées qui MANQUENT à la fiche gardée — par l'action de l'écran (audit, lieux, libellés suivent).
      const complement = new FormData();
      complement.set("id", garde.id);
      let aCompleter = false;
      for (const c of COORDONNEES) {
        const valeur = garde[c] ? null : autres.map((a) => a[c]).find((v) => !!v);
        if (valeur) { complement.set(c, valeur); aCompleter = true; }
      }
      if (aCompleter) {
        const r = await updateInstitution(complement);
        if (!r.ok) return { ok: false, error: r.error ?? "Complément refusé." };
      }
      for (const a of autres) {
        // 2. Les praticiens rattachés, et les secteurs (un secteur déjà tenu par la fiche gardée n'est pas doublé).
        await prisma.medicalDoctor.updateMany({ where: { institutionId: a.id }, data: { institutionId: garde.id, institution: garde.name } });
        const liens = await prisma.salesSectorInstitution.findMany({ where: { institutionId: a.id }, select: { id: true, sectorId: true } });
        const tenus = new Set((await prisma.salesSectorInstitution.findMany({ where: { institutionId: garde.id }, select: { sectorId: true } })).map((x) => x.sectorId));
        for (const l of liens) {
          if (tenus.has(l.sectorId)) await prisma.salesSectorInstitution.delete({ where: { id: l.id } });
          else { await prisma.salesSectorInstitution.update({ where: { id: l.id }, data: { institutionId: garde.id } }); tenus.add(l.sectorId); }
        }
        // 3. La fiche absorbée est désactivée, avec la trace de la fusion.
        const d = new FormData();
        d.set("id", a.id);
        d.set("isActive", "false");
        d.set("notes", `${a.notes ? `${a.notes}\n` : ""}Fusionnée dans « ${garde.name} » (${garde.id}) le ${new Date().toLocaleDateString("fr-FR")}.`);
        const r = await updateInstitution(d);
        if (!r.ok) return { ok: false, error: r.error ?? "Désactivation refusée." };
        fusionnees += 1;
      }
      await reposerWilayaCode("MedicalInstitution", garde.id); // double écriture des lieux (V2-D) : la wilaya complétée
      await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "INSTITUTION", entityId: garde.id, summary: `Doublons fusionnés dans « ${garde.name} » : ${autres.map((a) => a.name).join(", ")}` });
    }
    revalidatePath("/medical");
    if (!fusionnees) return { ok: false, error: "Aucune fiche à fusionner (déjà fusionnées, ou introuvables)." };
    return { ok: true, fusionnees };
  });
}
