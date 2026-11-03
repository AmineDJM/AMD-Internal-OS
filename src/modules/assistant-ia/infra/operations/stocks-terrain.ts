import { prisma } from "@/lib/prisma";
import { peutDemanderEtatStock, REFUS_DEMANDE_STOCK, userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { recordStockSnapshot } from "@/lib/actions/stock-snapshot-actions";
import { creerDemandeStocks } from "@/lib/actions/demande-stocks-actions";
import { liste, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { motsDuNom } from "../../domaine/annuaire/analyse";
import { joursJusqua } from "../../domaine/annuaire/demandes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉLÉGUÉ RELÈVE SES STOCKS (lot T2 bis, décision 0061) — « le délégué peut enregistrer de lui-même des stocks »
 * (Direction, 03/11/2026). La demande FORMELLE, elle, lui est refusée (`canRequestStockState`).
 *
 * Mesuré : la capacité générique `recordStockSnapshot` attend l'identifiant d'un DOSSIER RÉGLEMENTAIRE, que le délégué
 * ne peut pas désigner (il n'a pas le module Regulatory) — « Daclavir » restait introuvable. Ce geste résout le produit
 * dans SA GAMME (les produits de sa BU) et le lieu dans SES SECTEURS (pharmacie, hôpital), montre la carte, puis appelle
 * l'action de l'écran — qui rejuge la portée (§118.134) : un lieu hors secteur est refusé, au clic comme à l'écran.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const parMots = (t: string) => motsDuNom(t).map((m) => ({ contains: m, mode: "insensitive" as const }));

/** Les produits commercialisés dont le nom, la marque ou la DCI porte les mots dits — dans une BU, ou dans tout le catalogue. */
async function produitsParNom(dit: string, businessUnitId?: string | null) {
  const mots = parMots(dit);
  const ps = await prisma.promoProduct.findMany({
    where: {
      isActive: true, regulatoryProductId: { not: null }, ...(businessUnitId ? { businessUnitId } : {}),
      OR: [{ AND: mots.map((m) => ({ name: m })) }, { regulatoryProduct: { OR: [{ AND: mots.map((m) => ({ brandName: m })) }, { AND: mots.map((m) => ({ dci: m })) }] } }],
    },
    select: { regulatoryProductId: true, name: true },
    take: 10,
  });
  return [...new Map(ps.map((p) => [p.regulatoryProductId!, p.name])).entries()].map(([id, nom]) => ({ id, nom }));
}

async function produitsDeLaGamme(user: CurrentUser, dit: string) {
  const profil = await prisma.salesRepProfile.findUnique({ where: { repId: user.id }, select: { businessUnitId: true } });
  return produitsParNom(dit, profil?.businessUnitId);
}

async function lieuxDuSecteur(user: CurrentUser, dit: string) {
  const mots = parMots(dit.replace(/\b(pharmacie|officine|h[oô]pital)\b/gi, " ").trim() || dit);
  const secteurs = await prisma.salesSectorRep.count({ where: { repId: user.id } });
  return prisma.medicalInstitution.findMany({
    where: {
      isActive: true, AND: mots.map((m) => ({ name: m })),
      // Un délégué affecté à des secteurs ne relève que leurs lieux ; l'action le rejuge de toute façon.
      ...(secteurs ? { sectors: { some: { sector: { isActive: true, reps: { some: { repId: user.id } } } } } } : {}),
    },
    select: { id: true, name: true, wilaya: true },
    take: 6,
  });
}

const aujourdHui = () => new Date().toISOString().slice(0, 10);

export const RELEVE_STOCK: OperationIA = {
  nom: "releve_stock",
  module: "STOCKS",
  libelle: "Stock relevé",
  description:
    "ENREGISTRER UN ÉTAT DE STOCK que la personne a constaté elle-même : « il reste 40 boîtes de Daclavir à la pharmacie Ibn Sina ». "
    + "Le produit se trouve dans SA gamme, le lieu (pharmacie, hôpital) dans SES secteurs ; date = aujourd'hui par défaut. UNE carte. "
    + "Ce n'est pas une demande d'état de stock adressée à d'autres (réservée au marketing, aux opérations, au National Sales).",
  schema: {
    type: "object",
    properties: {
      produit: { type: "string", description: "Le produit, tel que dit (« Daclavir »)." },
      etablissement: { type: "string", description: "La pharmacie ou l'hôpital, tel que dit." },
      quantite: { type: "number", description: "Unités restantes (≥ 0)." },
      date: { type: "string", description: "AAAA-MM-JJ (défaut : aujourd'hui)." },
    },
    required: ["produit", "etablissement", "quantite"],
  },
  ouverte: (u) => userCan(u, "STOCKS", "CREATE") || userCan(u, "STOCKS", "UPDATE"),
  proposer: async (entree, user): Promise<PropositionOperation> => {
    const quantite = nombre(entree, "quantite");
    if (quantite === null || quantite < 0) return { manque: ["la quantité restante"] };
    const produits = await produitsDeLaGamme(user, texte(entree, "produit"));
    if (!produits.length) return { erreur: `Aucun produit « ${texte(entree, "produit")} » dans votre gamme.` };
    if (produits.length > 1) return { manque: [`lequel de ces produits : ${produits.map((p) => p.nom).join(" ; ")}`] };
    const lieux = await lieuxDuSecteur(user, texte(entree, "etablissement"));
    if (!lieux.length) return { erreur: `« ${texte(entree, "etablissement")} » n'est pas un établissement de vos secteurs.` };
    if (lieux.length > 1) return { manque: [`lequel de ces établissements : ${lieux.map((l) => `${l.name}${l.wilaya ? ` (${l.wilaya})` : ""}`).join(" ; ")}`] };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(texte(entree, "date")) ? texte(entree, "date") : aujourdHui();
    const [p, l] = [produits[0]!, lieux[0]!];
    return {
      carte: {
        title: `Relever le stock — ${p.nom} à ${l.name}`,
        fields: [{ label: "Produit", value: p.nom }, { label: "Lieu", value: l.name }, { label: "Quantité restante", value: String(Math.round(quantite)) }, { label: "Date", value: date }],
        warnings: ["Un seul état par jour et par lieu : un relevé du même jour est remplacé. Annulable."],
        libelleBouton: "Enregistrer le stock",
      },
      args: { productId: p.id, institutionId: l.id, quantity: String(Math.round(quantite)), date },
    };
  },
  executer: async (args) => {
    const fd = new FormData();
    fd.set("scope", "HOSPITAL");
    fd.set("institutionId", args.institutionId ?? "");
    fd.set("productId", args.productId ?? "");
    fd.set("quantity", args.quantity ?? "");
    fd.set("date", args.date ?? aujourdHui());
    const r = await recordStockSnapshot(fd);
    return r.ok ? { ok: true, message: "État de stock enregistré.", link: "/stocks" } : { ok: false, error: r.error };
  },
};

/**
 * LA DEMANDE FORMELLE D'ÉTAT DE STOCK (lot T2 bis, décision 0061) — « ça peut être le marketing, les opérations, le National
 * Sales Manager ; ça peut pas être le délégué » (Direction, 03/11/2026). Mesuré au banc réel : la capacité générique
 * attendait des identifiants d'établissements et de dossiers réglementaires ; le modèle se rabattait sur une tâche à une
 * personne, ou demandait « à qui ». Ici le serveur résout le produit et les établissements par leurs noms, montre qui
 * recevra la demande (les KAM qui couvrent chaque case), puis appelle l'action de l'écran (`creerDemandeStocks`), qui
 * rejuge le droit. Le délégué reçoit le refus franc, avec son geste à lui (le relevé).
 */
export const peutLancerDemandeStock = (u: CurrentUser): boolean => peutDemanderEtatStock(u);

/** Une question qui revient à demander un état de stock à d'autres — la demande formelle, sous un autre nom. */
export const DEMANDE_D_ETAT_DE_STOCK = /(?<![\p{L}])[ée]tats?\s+(de|du|des)\s+stocks?(?![\p{L}])|(?<![\p{L}])stocks?\s+(restants?|disponibles?)|(?<![\p{L}])combien(?![\p{L}]).{0,40}(reste|restent|boîtes?|boites?|unités?)(?![\p{L}])/iu;

async function etablissementsInterrogeables(dit: string) {
  const mots = parMots(dit.replace(/\b(pharmacie|officine|h[oô]pital|chu|clinique)\b/gi, " ").trim() || dit);
  return prisma.medicalInstitution.findMany({
    where: { isActive: true, AND: mots.map((m) => ({ name: m })) },
    select: { id: true, name: true, wilaya: true, sectors: { where: { sector: { isActive: true } }, select: { sector: { select: { reps: { where: { rep: { isActive: true } }, select: { rep: { select: { name: true } } } } } } } } },
    take: 6,
  });
}

export const DEMANDE_ETAT_STOCK: OperationIA = {
  nom: "demande_etat_stock",
  module: "STOCKS",
  libelle: "Demande d'état de stock lancée",
  description:
    "LANCER UNE DEMANDE FORMELLE D'ÉTAT DE STOCK aux KAM qui couvrent des établissements : « lance une demande d'état de stock de "
    + "Daclavir à la pharmacie Ibn Sina pour vendredi ». Les destinataires sont déduits de la couverture (pas besoin de les nommer). "
    + "Réservée au marketing, aux opérations, au National Sales et à la Direction ; un délégué ne la lance pas (il relève son stock : releve_stock).",
  schema: {
    type: "object",
    properties: {
      produits: { type: "array", items: { type: "string" }, description: "Les produits, tels que dits (vide = tous ceux couverts)." },
      etablissements: { type: "array", items: { type: "string" }, description: "Les établissements, tels que dits (vide = tous)." },
      echeance: { type: "string", description: "AAAA-MM-JJ, ou un jour (« vendredi »)." },
      titre: { type: "string" },
    },
  },
  ouverte: (u) => !u.impersonatedBy && userCan(u, "STOCKS", "VIEW"),
  proposer: async (entree, user): Promise<PropositionOperation> => {
    if (!peutLancerDemandeStock(user)) return { erreur: REFUS_DEMANDE_STOCK };
    const produits: { id: string; nom: string }[] = [];
    for (const dit of liste(entree, "produits").slice(0, 10)) {
      const ps = await produitsParNom(dit);
      if (!ps.length) return { erreur: `Aucun produit « ${dit} » au catalogue.` };
      if (ps.length > 1) return { manque: [`lequel de ces produits : ${ps.map((p) => p.nom).join(" ; ")}`] };
      produits.push(ps[0]!);
    }
    const lieux: Awaited<ReturnType<typeof etablissementsInterrogeables>> = [];
    for (const dit of liste(entree, "etablissements").slice(0, 20)) {
      const ls = await etablissementsInterrogeables(dit);
      if (!ls.length) return { erreur: `« ${dit} » n'est pas un établissement qu'une demande d'état de stock peut viser.` };
      if (ls.length > 1) return { manque: [`lequel de ces établissements : ${ls.map((l) => `${l.name}${l.wilaya ? ` (${l.wilaya})` : ""}`).join(" ; ")}`] };
      lieux.push(ls[0]!);
    }
    const jours = joursJusqua(texte(entree, "echeance"), new Date());
    const echeance = /^\d{4}-\d{2}-\d{2}$/.test(texte(entree, "echeance")) ? texte(entree, "echeance")
      : jours !== null ? new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10) : "";
    const kams = [...new Set(lieux.flatMap((l) => l.sectors.flatMap((s) => s.sector.reps.map((r) => r.rep.name))))];
    const titre = texte(entree, "titre") || `État de stock${produits.length ? ` — ${produits.map((p) => p.nom).join(", ")}` : ""}${lieux.length ? ` — ${lieux.map((l) => l.name).join(", ")}` : ""}`;
    return {
      carte: {
        title: `Lancer la demande d'état de stock — ${titre.replace(/^État de stock — /, "")}`,
        fields: [
          { label: "Produits", value: produits.length ? produits.map((p) => p.nom).join(", ") : "tous les produits couverts" },
          { label: "Établissements", value: lieux.length ? lieux.map((l) => l.name).join(", ") : "tous les établissements couverts" },
          ...(lieux.length ? [{ label: "Destinataires (KAM qui couvrent)", value: kams.join(", ") || "aucun KAM ne couvre ces établissements" }] : []),
          { label: "Échéance", value: echeance || "sans échéance" },
        ],
        warnings: ["Chaque KAM reçoit sa demande dans l'ERP (notification interne). Annulable."],
        libelleBouton: "Lancer la demande",
      },
      args: { titre, echeance, hopitalIds: lieux.map((l) => l.id).join(","), produitIds: produits.map((p) => p.id).join(",") },
    };
  },
  executer: async (args) => {
    const fd = new FormData();
    fd.set("titre", args.titre ?? "État de stock");
    if (args.echeance) fd.set("echeance", args.echeance);
    const hs = (args.hopitalIds ?? "").split(",").filter(Boolean);
    const ps = (args.produitIds ?? "").split(",").filter(Boolean);
    for (const h of hs) fd.append("hopitalId", h);
    if (hs.length) for (const h of hs) for (const p of ps) { fd.append("produitHopitalId", h); fd.append("produitId", p); }
    else for (const p of ps) fd.append("produitCommunId", p);
    const r = await creerDemandeStocks(fd);
    return r.ok ? { ok: true, message: "Demande d'état de stock lancée.", link: "/stocks" } : { ok: false, error: r.error };
  },
};
