import { prisma } from "@/lib/prisma";
import { scopeMedicalDoctors, userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { createFieldReport, rattacherPhotoTerrain, updateFieldReport } from "@/lib/actions/field-report-actions";
import { demanderMateriel } from "@/lib/actions/promo-stock-actions";
import { ouvrirPlanTournee, planifierVisites } from "@/lib/actions/tour-plan-actions";
import { lienRapportTerrain } from "@/lib/chemins/rapports-terrain";
import { champs, liste, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { resoudreMedecin, resoudreProduits, type CandidatMedecin, type ProduitConnu } from "../../domaine/terrain/resolution";
import { LIBELLE_PHOTO, SORTES_PHOTO, type SortePhoto } from "../../domaine/terrain/photo";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DU TERRAIN (lot J13, décision 0025) — préparés par le vocal, la photo, le texte ou la voix ;
 * exécutés au clic, par L'ACTION DE L'ÉCRAN, jamais par une écriture directe.
 *
 *   • `terrain_compte_rendu`  — le compte rendu de visite PRÉ-REMPLI (brouillon, que le délégué relit et envoie) ;
 *   • `terrain_demande_materiel` — la demande d'échantillons / de matériel au magasin (`demanderMateriel`) ;
 *   • `terrain_tournee_demain` — le médecin ajouté à la tournée de demain (`planifierVisites`, sélection
 *     COMPLÈTE relue pour ne rien retirer) ;
 *   • `terrain_piece_visite` — la photo rattachée comme pièce au compte rendu de la visite.
 *
 * Le médecin n'est jamais choisi à la place du délégué : résolu dans SON annuaire (`scopeMedicalDoctors`),
 * sinon la carte le dit (inconnu, ou candidats).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ouvertTerrain = (u: CurrentUser) => userCan(u, "FIELD_REPORTS", "VIEW");

/** L'annuaire que la personne voit — les candidats de la résolution. */
export async function candidatsMedecins(user: CurrentUser, take = 2_000): Promise<CandidatMedecin[]> {
  const ds = await prisma.medicalDoctor.findMany({
    where: scopeMedicalDoctors(user),
    select: { id: true, name: true, institution: true, specialty: true, institutionRef: { select: { name: true } }, specialtyRef: { select: { name: true } } },
    orderBy: { name: "asc" },
    take,
  });
  return ds.map((d) => ({ id: d.id, nom: d.name, etablissement: d.institutionRef?.name ?? d.institution ?? null, specialite: d.specialtyRef?.name ?? d.specialty ?? null }));
}

/** Les produits de la gamme du délégué (sa BU) — à défaut, ceux de toutes les gammes actives. */
export async function produitsDuDelegue(userId: string): Promise<ProduitConnu[]> {
  const profil = await prisma.salesRepProfile.findUnique({ where: { repId: userId }, select: { businessUnitId: true } });
  const ps = await prisma.promoProduct.findMany({
    where: { isActive: true, ...(profil?.businessUnitId ? { businessUnitId: profil.businessUnitId } : {}) },
    select: { id: true, name: true, productId: true },
    take: 300,
  });
  return ps.map((p) => ({ id: p.productId ?? p.id, nom: p.name }));
}

async function medecinDesigne(user: CurrentUser, e: Record<string, unknown>): Promise<
  { ok: true; medecin: CandidatMedecin | null; note: string | null } | { ok: false; manque: string }
> {
  const id = texte(e, "medecinId");
  if (id) {
    const d = await prisma.medicalDoctor.findFirst({ where: { AND: [scopeMedicalDoctors(user), { id }] }, select: { id: true, name: true, institution: true } });
    return d ? { ok: true, medecin: { id: d.id, nom: d.name, etablissement: d.institution }, note: null } : { ok: false, manque: "le médecin désigné n'est pas dans votre annuaire — son nom" };
  }
  const dit = texte(e, "medecin");
  if (!dit) return { ok: true, medecin: null, note: null };
  const r = resoudreMedecin(dit, texte(e, "etablissement") || null, await candidatsMedecins(user));
  if (r.statut === "RESOLU") return { ok: true, medecin: r.medecin, note: null };
  if (r.statut === "AMBIGU") return { ok: true, medecin: null, note: `« ${dit} » : plusieurs médecins de votre annuaire possibles (${r.candidats.map((c) => c.nom).join(", ")}) — à choisir dans le compte rendu.` };
  return { ok: true, medecin: null, note: `« ${dit} » n'est pas dans votre annuaire : le nom est gardé tel que dicté.` };
}

const demain = (maintenant = new Date()): Date => {
  const d = new Date(maintenant);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
};
const jourIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ─────────────────────────────── Le compte rendu pré-rempli ───────────────────────────────

export const TERRAIN_COMPTE_RENDU: OperationIA = {
  nom: "terrain_compte_rendu",
  module: "FIELD_REPORTS",
  libelle: "Compte rendu de visite préparé",
  description:
    "PRÉPARE le compte rendu d'une visite médicale (rapport terrain) à partir de ce que le délégué raconte : médecin, établissement, "
    + "produits présentés, synthèse. Le médecin est retrouvé dans l'annuaire du délégué. Crée un BROUILLON pré-rempli, que le délégué relit et envoie.",
  schema: {
    type: "object",
    properties: {
      medecin: { type: "string", description: "Nom du médecin tel que dit (« Dr Benali »)." },
      medecinId: { type: "string", description: "Identifiant d'annuaire, s'il est déjà connu." },
      etablissement: { type: "string" },
      specialite: { type: "string" },
      produits: { type: "array", items: { type: "string" } },
      synthese: { type: "string", description: "Le compte rendu rédigé, fidèle à ce qui est dit." },
      date: { type: "string", description: "Date de la visite (AAAA-MM-JJ) ; aujourd'hui par défaut." },
      aConfirmer: { type: "array", items: { type: "string" } },
    },
    required: ["synthese"],
  },
  ouverte: ouvertTerrain,

  async proposer(e, user): Promise<PropositionOperation> {
    const synthese = texte(e, "synthese");
    if (!synthese) return { manque: ["ce qui s'est dit pendant la visite (la synthèse du compte rendu)"] };
    const m = await medecinDesigne(user, e);
    if (!m.ok) return { manque: [m.manque] };
    const produits = resoudreProduits(liste(e, "produits"), await produitsDuDelegue(user.id));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(texte(e, "date")) ? texte(e, "date") : jourIso(new Date());
    const warnings = [...(m.note ? [m.note] : []), ...liste(e, "aConfirmer").map((x) => `À vérifier : ${x}`)];
    const nomsProduits = produits.map((p) => p.produit?.nom ?? `${p.dit} (hors catalogue)`).join(", ");
    return {
      carte: {
        title: `Compte rendu — ${m.medecin?.nom ?? (texte(e, "medecin") || "visite")}`,
        fields: champs([
          ["Médecin", m.medecin ? `${m.medecin.nom} (annuaire)` : texte(e, "medecin") || "non dit"],
          ["Établissement", texte(e, "etablissement") || m.medecin?.etablissement || null],
          ["Spécialité", texte(e, "specialite") || null],
          ["Produits", nomsProduits || null],
          ["Date de visite", date],
          ["Synthèse", synthese.length > 600 ? `${synthese.slice(0, 600)}…` : synthese],
        ]),
        warnings,
        libelleBouton: "Créer le brouillon du compte rendu",
      },
      args: {
        synthese, date, medecinId: m.medecin?.id ?? null, medecin: m.medecin?.nom ?? (texte(e, "medecin") || null),
        etablissement: texte(e, "etablissement") || m.medecin?.etablissement || null, specialite: texte(e, "specialite") || null,
      },
    };
  },

  async executer(a) {
    const cree = await createFieldReport();
    if (!cree.ok || !cree.id) return { ok: false, error: cree.error ?? "Le compte rendu n'a pas pu être créé." };
    const f = new FormData();
    f.set("id", cree.id);
    f.set("summary", a.synthese ?? "");
    if (a.date) f.set("visitDate", a.date);
    if (a.medecinId) f.set("doctorIds", a.medecinId);
    if (!a.medecinId && a.medecin) f.set("doctorName", a.medecin);
    if (a.etablissement) f.set("institution", a.etablissement);
    if (a.specialite) f.set("specialty", a.specialite);
    const r = await updateFieldReport(f);
    if (!r.ok) return { ok: false, error: r.error ?? "Le compte rendu a été créé vide : complétez-le à l'écran.", link: lienRapportTerrain(cree.id) };
    return { ok: true, message: "Brouillon créé : relisez-le, puis « Envoyer mon compte rendu ».", link: lienRapportTerrain(cree.id) };
  },
};

// ─────────────────────────────── La demande d'échantillons / de matériel ───────────────────────────────

/** Les articles du magasin qu'un produit dit désigne (lien produit, ou nom). */
async function articlesPour(produit: string | null): Promise<{ id: string; name: string }[]> {
  const articles = await prisma.promoStockItem.findMany({
    where: { isActive: true },
    select: { id: true, name: true, produits: { select: { product: { select: { canonicalName: true } } } } },
    take: 500,
  });
  if (!produit) return [];
  const noms = articles.map((a) => ({ id: a.id, nom: [a.name, ...a.produits.map((p) => p.product.canonicalName)].join(" ") }));
  const r = resoudreProduits([produit], noms.map((n) => ({ id: n.id, nom: n.nom })));
  const exact = r[0]?.produit ? articles.filter((a) => a.id === r[0].produit!.id) : [];
  const contient = articles.filter((a) => noms.find((n) => n.id === a.id)!.nom.toLowerCase().includes(produit.toLowerCase()));
  return [...new Map([...exact, ...contient].map((a) => [a.id, { id: a.id, name: a.name }])).values()].slice(0, 5);
}

export const TERRAIN_DEMANDE_MATERIEL: OperationIA = {
  nom: "terrain_demande_materiel",
  module: "FIELD_REPORTS",
  libelle: "Demande d'échantillons préparée",
  description:
    "PRÉPARE une demande d'échantillons ou de matériel promotionnel au magasin pour le délégué (après une visite : « il veut des échantillons de X »). "
    + "Désigne l'article par le produit ou son nom, avec une quantité.",
  schema: {
    type: "object",
    properties: {
      produit: { type: "string", description: "Produit ou article demandé." },
      articleId: { type: "string" },
      quantite: { type: "number" },
      note: { type: "string", description: "Pour qui, pourquoi (« pour le Dr Benali, CHU Oran »)." },
    },
  },
  ouverte: ouvertTerrain,

  async proposer(e): Promise<PropositionOperation> {
    const quantite = nombre(e, "quantite");
    let article: { id: string; name: string } | null = null;
    const id = texte(e, "articleId");
    if (id) article = await prisma.promoStockItem.findFirst({ where: { id, isActive: true }, select: { id: true, name: true } });
    if (!article) {
      const produit = texte(e, "produit");
      if (!produit) return { manque: ["quel produit ou article demander au magasin"] };
      const trouves = await articlesPour(produit);
      if (!trouves.length) return { erreur: `Aucun article du magasin ne correspond à « ${produit} » : la demande se fait depuis le stock promotionnel.` };
      if (trouves.length > 1) return { manque: [`lequel de ces articles : ${trouves.map((t) => t.name).join(" ; ")}`] };
      article = trouves[0];
    }
    if (quantite == null || quantite <= 0) return { manque: [`combien de « ${article.name} » demander`] };
    return {
      carte: {
        title: `Demande au magasin — ${article.name}`,
        fields: champs([["Article", article.name], ["Quantité", String(quantite)], ["Note", texte(e, "note") || null]]),
        warnings: ["La demande part au magasin, qui la sert en dotation."],
        libelleBouton: "Envoyer la demande au magasin",
      },
      args: { itemId: article.id, quantite: String(quantite), note: texte(e, "note") || null },
    };
  },

  async executer(a) {
    const f = new FormData();
    f.set("itemId", a.itemId ?? "");
    f.set("quantite", a.quantite ?? "");
    if (a.note) f.set("note", a.note);
    const r = await demanderMateriel(f);
    return r.ok ? { ok: true, message: "Demande envoyée au magasin." } : { ok: false, error: r.error ?? "La demande n'a pas pu partir." };
  },
};

// ─────────────────────────────── La tournée du lendemain ───────────────────────────────

export const TERRAIN_TOURNEE_DEMAIN: OperationIA = {
  nom: "terrain_tournee_demain",
  module: "MEDICAL",
  libelle: "Tournée de demain mise à jour (proposée)",
  description: "PROPOSE d'ajouter un médecin de l'annuaire à la tournée de DEMAIN du délégué (« je le revois demain »). Les autres visites du plan sont gardées.",
  schema: {
    type: "object",
    properties: { medecin: { type: "string" }, medecinId: { type: "string" }, etablissement: { type: "string" } },
  },
  ouverte: (u) => userCan(u, "MEDICAL", "CREATE"),

  async proposer(e, user): Promise<PropositionOperation> {
    const m = await medecinDesigne(user, e);
    if (!m.ok) return { manque: [m.manque] };
    if (!m.medecin) return { erreur: m.note ?? "Quel médecin revoir demain ? Il doit être dans votre annuaire pour entrer dans la tournée." };
    const jour = demain();
    const deja = await prisma.medicalVisit.findFirst({
      where: { delegateId: user.id, doctorId: m.medecin.id, date: { gte: new Date(jour.getFullYear(), jour.getMonth(), jour.getDate()), lt: new Date(jour.getFullYear(), jour.getMonth(), jour.getDate() + 1) } },
      select: { id: true },
    });
    if (deja) return { erreur: `${m.medecin.nom} est déjà dans votre tournée de demain.` };
    return {
      carte: {
        title: `Tournée de demain — ajouter ${m.medecin.nom}`,
        fields: champs([["Médecin", m.medecin.nom], ["Établissement", m.medecin.etablissement ?? null], ["Jour", jour.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })]]),
        warnings: ["Le plan de tournée garde ses autres visites ; un plan déjà validé se révise depuis « Plan de tournée »."],
        libelleBouton: "Ajouter à la tournée de demain",
      },
      args: { medecinId: m.medecin.id, jour: jourIso(jour) },
    };
  },

  async executer(a) {
    if (!a.medecinId || !a.jour) return { ok: false, error: "Proposition incomplète." };
    const o = new FormData();
    o.set("date", `${a.jour}T09:00:00`);
    const plan = await ouvrirPlanTournee(o);
    if (!plan.ok || !plan.id) return { ok: false, error: plan.error ?? "Le plan de tournée n'a pas pu s'ouvrir." };
    // LA SÉLECTION EST COMPLÈTE (`planifierVisites` remplace) : on relit tout le plan, on ajoute la paire.
    const existantes = await prisma.medicalVisit.findMany({ where: { tourPlanId: plan.id }, select: { date: true, doctorId: true } });
    const f = new FormData();
    f.set("planId", plan.id);
    for (const v of existantes) if (v.doctorId) f.append("visite", `${jourIso(v.date)}|${v.doctorId}`);
    f.append("visite", `${a.jour}|${a.medecinId}`);
    const r = await planifierVisites(f);
    return r.ok ? { ok: true, message: "Visite ajoutée à la tournée de demain.", link: "/medical/plan-de-tournee" } : { ok: false, error: r.error ?? "La tournée n'a pas pu être modifiée." };
  },
};

// ─────────────────────────────── La photo rattachée à la visite ───────────────────────────────

export const TERRAIN_PIECE_VISITE: OperationIA = {
  nom: "terrain_piece_visite",
  module: "FIELD_REPORTS",
  libelle: "Photo rattachée au compte rendu (proposée)",
  description: "PROPOSE de rattacher une photo de terrain déjà déposée (captation) comme pièce du compte rendu de visite le plus récent du délégué.",
  schema: { type: "object", properties: { captationId: { type: "string" }, rapportId: { type: "string" } }, required: ["captationId"] },
  ouverte: ouvertTerrain,

  async proposer(e, user): Promise<PropositionOperation> {
    const c = await prisma.assistantIaTerrainCapture.findFirst({
      where: { id: texte(e, "captationId"), userId: user.id, sorte: "PHOTO" },
      select: { id: true, nom: true, blobId: true, analyse: true },
    });
    if (!c?.blobId) return { erreur: "Photo introuvable." };
    const rapport = await prisma.fieldReport.findFirst({
      where: { delegateId: user.id, ...(texte(e, "rapportId") ? { id: texte(e, "rapportId") } : { createdAt: { gte: new Date(Date.now() - 2 * 86_400_000) } }) },
      orderBy: { createdAt: "desc" },
      select: { id: true, doctorName: true, visitDate: true, doctor: { select: { name: true } } },
    });
    if (!rapport) return { erreur: "Aucun compte rendu récent auquel rattacher la photo : dictez d'abord le compte rendu de la visite." };
    const sorte = (c.analyse as { sorte?: string } | null)?.sorte;
    const libelle = sorte && (SORTES_PHOTO as readonly string[]).includes(sorte) ? LIBELLE_PHOTO[sorte as SortePhoto] : "Photo";
    return {
      carte: {
        title: `Rattacher la photo au compte rendu`,
        fields: champs([["Photo", `${libelle} — ${c.nom}`], ["Compte rendu", `${rapport.doctor?.name ?? rapport.doctorName ?? "Visite"} du ${rapport.visitDate.toLocaleDateString("fr-FR")}`]]),
        warnings: [],
        libelleBouton: "Rattacher la photo",
      },
      args: { captationId: c.id, rapportId: rapport.id },
    };
  },

  async executer(a) {
    const f = new FormData();
    f.set("id", a.rapportId ?? "");
    f.set("captationId", a.captationId ?? "");
    const r = await rattacherPhotoTerrain(f);
    return r.ok
      ? { ok: true, message: "Photo rattachée au compte rendu.", link: lienRapportTerrain(a.rapportId ?? "") }
      : { ok: false, error: r.error ?? "La photo n'a pas pu être rattachée.", ...(a.rapportId ? { link: lienRapportTerrain(a.rapportId) } : {}) };
  },
};

export const OPERATIONS_TERRAIN: OperationIA[] = [TERRAIN_COMPTE_RENDU, TERRAIN_DEMANDE_MATERIEL, TERRAIN_TOURNEE_DEMAIN, TERRAIN_PIECE_VISITE];
