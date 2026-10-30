import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { createPromoMaterial } from "@/lib/actions/promo-material-actions";
import type { CurrentUser } from "@/lib/session";
import { champs, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { dateIso } from "./adpro-prise-en-charge";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDER DU MATÉRIEL PROMOTIONNEL — par l'action de l'écran (`createPromoMaterial`).
 *
 * Une demande naît avec ses LIGNES, chacune un article du CATALOGUE (actif), ce qu'on attend du
 * fournisseur (conception, impression…), une quantité, et le produit quand l'article n'existe que
 * pour un produit. L'article se désigne par son nom ou sa référence ; un nom qui en désigne
 * plusieurs revient avec ses candidats. La demande de devis part ensuite d'elle-même : la carte
 * le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ACTIONS: Record<string, string> = {
  conception: "CONCEPTION", creation: "CONCEPTION", maquette: "CONCEPTION", impression: "IMPRESSION", tirage: "IMPRESSION",
  fabrication: "FABRICATION", achat: "ACHAT", location: "LOCATION", livraison: "LIVRAISON", transport: "LIVRAISON",
  installation: "INSTALLATION", montage: "INSTALLATION", autre: "AUTRE",
};
const LIBELLE_ACTION: Record<string, string> = {
  CONCEPTION: "conception", IMPRESSION: "impression", FABRICATION: "fabrication", ACHAT: "achat",
  LOCATION: "location", LIVRAISON: "livraison", INSTALLATION: "installation", AUTRE: "autre",
};

interface LigneLue { article: string; quantite: string; actions: string[]; produit: string; commentaire: string }

function lignesDe(e: Record<string, unknown>): LigneLue[] {
  const v = e.articles;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({
    article: texte(x, "article"),
    quantite: texte(x, "quantite"),
    actions: (Array.isArray(x.actions) ? x.actions.map(String) : texte(x, "actions").split(/[,;]/)).map((a) => ACTIONS[replier(a)] ?? "").filter(Boolean),
    produit: texte(x, "produit"),
    commentaire: texte(x, "commentaire"),
  }));
}

export const MATERIEL_PROMO_CREATION: OperationIA = {
  nom: "preparer_materiel_promo",
  module: "PROMO_MATERIAL",
  libelle: "Demande de matériel promotionnel préparée",
  description:
    "PRÉPARE une demande de MATÉRIEL PROMOTIONNEL, exécutée à la confirmation par l'action de l'écran. Chaque ligne : un article du catalogue "
    + "(nom ou référence), les actions attendues du fournisseur (conception, impression, fabrication, achat, location, livraison, installation, autre), "
    + "une quantité, et le produit si l'article l'exige. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      titre: { type: "string", description: "Titre / campagne." },
      description: { type: "string" },
      besoinLe: { type: "string", description: "Date de besoin (AAAA-MM-JJ), facultative." },
      articles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            article: { type: "string", description: "Article du catalogue (nom ou référence)." },
            quantite: { type: "string" },
            actions: { type: "array", items: { type: "string" } },
            produit: { type: "string", description: "Produit concerné (si l'article l'exige)." },
            commentaire: { type: "string" },
          },
        },
      },
    },
  },
  ouverte: (u) => userCan(u, "PROMO_MATERIAL", "CREATE"),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const titre = texte(e, "titre");
    const lignes = lignesDe(e);
    const manque: string[] = [];
    if (!titre) manque.push("le titre ou la campagne");
    if (!lignes.length) manque.push("les articles voulus (du catalogue), avec pour chacun ce qu'on attend du fournisseur et la quantité");
    const besoin = texte(e, "besoinLe") ? dateIso(texte(e, "besoinLe")) : null;
    if (texte(e, "besoinLe") && !besoin) manque.push("une date de besoin lisible (jour, mois, année)");

    const resolues: { catalogueId: string; nom: string; ligne: LigneLue }[] = [];
    for (const [i, l] of lignes.entries()) {
      const n = i + 1;
      if (!l.article) { manque.push(`ligne ${n} : l'article du catalogue`); continue; }
      const trouves = await prisma.promoCatalogueArticle.findMany({
        where: { actif: true, OR: [{ nom: { contains: l.article, mode: "insensitive" } }, { reference: { equals: l.article, mode: "insensitive" } }] },
        select: { id: true, nom: true, reference: true, exigeProduit: true, famille: true },
        take: 6,
      });
      const exacts = trouves.filter((c) => replier(c.nom) === replier(l.article) || replier(c.reference) === replier(l.article));
      const c = exacts.length === 1 ? exacts[0] : trouves.length === 1 ? trouves[0] : null;
      if (!c) {
        manque.push(trouves.length > 1
          ? `ligne ${n} : quel article pour « ${l.article} » : ${trouves.map((t) => `${t.nom} (${t.reference})`).join(", ")}`
          : `ligne ${n} : « ${l.article} » n'est pas au catalogue actif — un autre article`);
        continue;
      }
      if (!l.actions.length) manque.push(`ligne ${n} (${c.nom}) : ce qu'on attend du fournisseur (conception, impression, achat…)`);
      if (c.exigeProduit && !l.produit) manque.push(`ligne ${n} (${c.nom}) : le produit concerné — cet article n'existe que pour un produit`);
      if (c.famille === "NUMERIQUE" && l.quantite) manque.push(`ligne ${n} (${c.nom}) : un support numérique n'a pas de quantité — à retirer`);
      resolues.push({ catalogueId: c.id, nom: c.nom, ligne: l });
    }
    if (manque.length) return { manque };

    const warnings: string[] = [];
    const proches = await prisma.promoMaterial.findMany({
      where: { requesterId: user.id, title: { equals: titre, mode: "insensitive" }, createdAt: { gte: new Date(Date.now() - 120 * 24 * 3600 * 1000) } },
      select: { reference: true, createdAt: true },
      take: 3,
    });
    if (proches.length) warnings.push(`Doublon possible : ${proches.map((p) => `${p.reference} du ${p.createdAt.toLocaleDateString("fr-FR")}`).join(" ; ")} — même titre.`);
    warnings.push("La demande suit son circuit (validation, puis devis demandés automatiquement aux fournisseurs). Le montant se connaîtra aux devis.");

    return {
      carte: {
        title: `Matériel promotionnel — ${titre}`,
        fields: champs([
          ["Campagne", titre],
          ...resolues.map((r, i): [string, string] => [
            `Ligne ${i + 1}`,
            `${r.nom}${r.ligne.quantite ? ` × ${r.ligne.quantite}` : ""} — ${r.ligne.actions.map((a) => LIBELLE_ACTION[a]).join(", ")}${r.ligne.produit ? ` (${r.ligne.produit})` : ""}`,
          ]),
          ["Besoin le", besoin],
          ["Description", texte(e, "description") || null],
        ]),
        warnings,
      },
      args: {
        title: titre,
        description: texte(e, "description") || null,
        neededBy: besoin,
        lignes: JSON.stringify(resolues.map((r) => ({
          catalogueId: r.catalogueId, quantite: r.ligne.quantite, actions: r.ligne.actions,
          produitIds: [], autre: r.ligne.produit, commentaire: r.ligne.commentaire,
        }))),
      },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const cle of ["title", "description", "neededBy", "lignes"]) if (a[cle]) fd.set(cle, a[cle]!);
    const r = await createPromoMaterial(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande a été refusée." };
    return {
      ok: true,
      message: r.message ?? "Demande de matériel promotionnel créée : elle suit son circuit.",
      ...(r.id ? { link: `/promo-material/${r.id}` } : {}),
      revalidate: ["/promo-material", "/ad-pro"],
    };
  },
};
