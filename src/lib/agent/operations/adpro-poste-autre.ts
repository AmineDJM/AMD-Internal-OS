import { userCan } from "@/lib/rbac";
import { addAdProItem } from "@/lib/actions/ad-pro-item-actions";
import { createAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";
import { ITEM_KIND_LABELS } from "@/lib/ad-pro-items";
import { getAppSettings } from "@/lib/settings";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import type { AdProItemKind } from "@prisma/client";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, idsDe, resoudrePieces } from "./pieces";
import { liste } from "./types";
import { replier } from "./annuaire-medical";
import { trouverDemande } from "./demandes-visibles";
import { avertissementBudget } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AJOUTER UN POSTE DE COÛT À UNE DEMANDE — et CRÉER UNE DEMANDE « AUTRE ».
 *
 * Le poste s'ajoute à une demande que la personne VOIT (`trouverDemande`), par l'action de
 * l'écran (`addAdProItem`) : c'est elle qui dit si le moment est venu (après la pré-validation de
 * la tenue), si la demande est close, si la personne peut éditer ses postes. La nature du poste
 * vient du vocabulaire de l'ERP ; rien d'inventé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PARENTS = new Set(["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT"]);

function natureDePoste(brut: string): AdProItemKind | null {
  const k = replier(brut);
  if (!k) return "OTHER";
  const trouve = (Object.entries(ITEM_KIND_LABELS) as [AdProItemKind, string][]).find(([code, libelle]) =>
    replier(libelle) === k || replier(code) === k || replier(libelle).includes(k));
  return trouve ? trouve[0] : null;
}

export const POSTE_AJOUT: OperationIA = {
  nom: "preparer_poste",
  module: "SPONSORING",
  libelle: "Poste de coût préparé",
  description:
    "PRÉPARE l'ajout d'un POSTE DE COÛT (stand, hôtellerie, billetterie, traiteur, location de salle, imprimerie, prestation…) à une demande Ad & Pro "
    + "existante (sponsoring, prise en charge, événement), désignée par sa référence ou son nom. Exécuté à la confirmation par l'action de l'écran, "
    + "qui dit si le moment est venu. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      demande: { type: "string", description: "Référence ou nom de la demande (ex. SPO-2026-014, « Congrès de cardiologie »)." },
      natureDemande: { type: "string", description: "sponsoring, congrès national, congrès international, événement (facultatif)." },
      libelle: { type: "string", description: "Libellé du poste." },
      naturePoste: { type: "string", description: `Nature : ${Object.values(ITEM_KIND_LABELS).join(", ")}.` },
      montant: { type: "number", description: "Estimation en DZD." },
      prestataire: { type: "string" },
      rallonge: { type: "boolean", description: "Vrai si le poste s'ajoute EN PLUS du budget accordé." },
      notes: { type: "string" },
    },
  },
  ouverte: (u) => ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS"].some((m) => userCan(u, m as never, "UPDATE") || userCan(u, m as never, "CREATE")),

  async proposer(e, user): Promise<PropositionOperation> {
    const demande = await trouverDemande(user, texte(e, "demande"), texte(e, "natureDemande"));
    const nature = natureDePoste(texte(e, "naturePoste"));
    const manque = [
      "manque" in demande ? demande.manque : null,
      !texte(e, "libelle") ? "le libellé du poste" : null,
      !nature ? `la nature du poste (${Object.values(ITEM_KIND_LABELS).join(", ")})` : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const d = demande as Exclude<typeof demande, { manque: string }>;
    if (!PARENTS.has(d.nature)) return { erreur: "Les postes de coût s'ajoutent à un sponsoring, une prise en charge ou un événement." };
    const montant = nombre(e, "montant");
    if (montant != null && montant < 0) return { erreur: "Un montant ne peut pas être négatif." };
    const warnings: string[] = [];
    const seuil = (await getAppSettings()).adProDgThreshold;
    if (montant != null && porteDgRequise(montant, seuil)) warnings.push(`Ce poste dépasse à lui seul le seuil de ${dzd(seuil)} du Directeur Général.`);
    warnings.push(await avertissementBudget(user, montant));
    if (e.rallonge === true) warnings.push("RALLONGE : ce poste s'ajoute EN PLUS du budget accordé — il sera arbitré à part.");
    warnings.push("L'action de l'écran vérifie que la demande accepte des postes (après la pré-validation de la tenue, demande non close).");
    return {
      carte: {
        title: `Ajouter le poste « ${texte(e, "libelle")} »`,
        fields: champs([
          ["Demande", d.libelle],
          ["Poste", `${texte(e, "libelle")} (${ITEM_KIND_LABELS[nature!]})`],
          ["Estimation", montant != null ? dzd(montant) : null],
          ["Prestataire", texte(e, "prestataire") || null],
          ["Budget", e.rallonge === true ? "Rallonge" : "Inclus dans le budget accordé"],
        ]),
        warnings,
      },
      args: {
        parent: d.nature, parentId: d.id, label: texte(e, "libelle"), kind: nature,
        amountEstimated: montant != null ? String(montant) : null, supplier: texte(e, "prestataire") || null,
        budgetKind: e.rallonge === true ? "ADDITIONAL" : null, notes: texte(e, "notes") || null, lien: d.lien,
      },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const cle of ["parent", "parentId", "label", "kind", "amountEstimated", "supplier", "budgetKind", "notes"]) if (a[cle]) fd.set(cle, a[cle]!);
    const r = await addAdProItem(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "L'ajout du poste a été refusé." };
    return { ok: true, message: "Poste ajouté à la demande.", ...(a.lien ? { link: a.lien } : {}), revalidate: [a.lien ?? "/ad-pro"] };
  },
};

export const AUTRE_CREATION: OperationIA = {
  nom: "preparer_demande_autre",
  module: "AD_PRO_OTHER",
  libelle: "Demande Ad & Pro « autre » préparée",
  description:
    "PRÉPARE une demande Ad & Pro « AUTRE » (hors sponsoring, prise en charge, événement, matériel) : un objet et une description — c'est sur elle "
    + "que son circuit décide (le N+1, le Directeur des opérations, puis la prévalidation de la Direction Marketing). Exécutée à la confirmation par "
    + "l'action de l'écran. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      objet: { type: "string" },
      description: { type: "string" },
      beneficiaire: { type: "string" },
      montant: { type: "number", description: "Montant estimé en DZD." },
      pieces: { type: "string", description: "Pièces jointes : noms ou identifiants de fichiers." },
    },
  },
  ouverte: (u) => userCan(u, "AD_PRO_OTHER", "CREATE"),

  async proposer(e, user): Promise<PropositionOperation> {
    const manque = [
      !texte(e, "objet") ? "l'objet de la demande" : null,
      !texte(e, "description") ? "une description — c'est sur elle que la décision se prendra" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const pieces = await resoudrePieces(user, liste(e, "pieces"));
    if ("erreur" in pieces) return { erreur: pieces.erreur };
    const montant = nombre(e, "montant");
    // LE CIRCUIT COMMUN (27/10/2026, décision #17) : la route du créateur, puis les postes ; le DG valide le
    // TOTAL des postes au-dessus du seuil, pas le montant demandé.
    const warnings: string[] = [
      "La demande suit le circuit Ad & Pro : son N+1, le Directeur des opérations, puis la prévalidation de la Direction Marketing ; les postes s'ajoutent après.",
      await avertissementBudget(user, montant),
    ];
    const seuil = (await getAppSettings()).adProDgThreshold;
    if (montant != null && porteDgRequise(montant, seuil)) warnings.push(`Au-delà du seuil de ${dzd(seuil)} : le Directeur Général validera le total des postes.`);
    return {
      carte: {
        title: `Demande « autre » — ${texte(e, "objet")}`,
        fields: champs([
          ["Objet", texte(e, "objet")], ["Description", texte(e, "description")],
          ["Bénéficiaire", texte(e, "beneficiaire") || null], ["Montant estimé", montant != null ? dzd(montant) : null],
          ["Pièces", pieces.length ? pieces.map((p) => p.nom).join(", ") : null],
        ]),
        warnings,
      },
      args: {
        title: texte(e, "objet"), description: texte(e, "description"), beneficiary: texte(e, "beneficiaire") || null,
        amount: montant != null ? String(montant) : null, pieces: JSON.stringify(pieces.map((p) => p.id)),
      },
    };
  },

  async executer(a, user) {
    const fichiers = await fichiersDepuisDrive(user, idsDe(a.pieces));
    if (!Array.isArray(fichiers)) return { ok: false, error: fichiers.erreur };
    const fd = new FormData();
    for (const cle of ["title", "description", "beneficiary", "amount"]) if (a[cle]) fd.set(cle, a[cle]!);
    for (const f of fichiers) fd.append("annexes", f);
    const r = await createAdProOtherRequest(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande a été refusée." };
    return { ok: true, message: r.message ?? "Demande créée : elle part dans son circuit de validation.", ...(r.id ? { link: `/ad-pro/autres/${r.id}` } : {}), revalidate: ["/ad-pro"] };
  },
};
