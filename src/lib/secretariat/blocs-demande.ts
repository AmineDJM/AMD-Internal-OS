import { periodeCourte } from "./tableau-bureau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BLOCS EN TÊTE DE LA FICHE D'UNE DEMANDE (Super Admin, 24/11/2026) — « une fiche adaptée à son type ».
 *
 * La fiche listait tous les champs saisis à la suite (« Ville de départ », « Ville d'arrivée », « Date de
 * départ »…), quel que soit le type. Elle montre désormais, en tête, ce qui DIT la demande : le trajet et
 * les dates d'un déplacement, le destinataire d'un courrier, le document d'une signature, le bénéficiaire
 * et le montant d'un paiement, l'article d'un achat. Les champs qu'aucun bloc ne reprend restent listés dans
 * « La demande » (`champsRestants`) : rien de ce que le demandeur a saisi ne se perd.
 *
 * Module PUR : la page serveur et les bancs lisent la même règle. Un type sans blocs (invité, autre, les
 * types retirés relus) garde la liste générique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BlocDemande {
  titre: string;
  valeur: string;
  detail?: string | null;
}

type Champs = Record<string, unknown>;

const texte = (f: Champs, cle: string): string | null => {
  const v = f[cle];
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const oui = (f: Champs, cle: string) => texte(f, cle)?.toLowerCase() === "oui";

const MODE_ENVOI: Record<string, string> = { mail: "Mail", depot: "Dépôt physique", courrier: "Courrier", autre: "Autre" };
const ACTION_SIGNATURE: Record<string, string> = {
  signature: "Signature", cachet: "Cachet", scan: "Scan", impression: "Impression", classement: "Classement", autre: "Autre",
};

const montantLisible = (v: string | null, devise: string | null) => {
  if (!v) return null;
  const n = Number(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString("fr-FR")} ${devise ?? "DZD"}` : `${v} ${devise ?? ""}`.trim();
};

/** Les blocs d'un type, et les CLÉS de champs qu'ils reprennent. */
function blocsEtCles(type: string, f: Champs): { blocs: BlocDemande[]; cles: string[] } | null {
  switch (type) {
    case "TRAVEL": {
      const de = texte(f, "villeDepart"), vers = texte(f, "villeArrivee");
      const besoins = [
        oui(f, "billet") ? "Billet" : null,
        oui(f, "hotel") ? `Hôtel${texte(f, "nbNuits") ? ` · ${texte(f, "nbNuits")} nuit${Number(texte(f, "nbNuits")) > 1 ? "s" : ""}` : ""}` : null,
      ].filter(Boolean).join(" · ");
      return {
        blocs: [
          { titre: "Trajet", valeur: de || vers ? `${de ?? "?"} → ${vers ?? "?"}` : "À préciser", detail: texte(f, "poste") },
          { titre: "Dates", valeur: periodeCourte(texte(f, "dateDepart"), texte(f, "dateRetour")) ?? "À préciser" },
          { titre: "Billet · hôtel", valeur: besoins || "Ni billet ni hôtel", detail: texte(f, "hotelPref") ? `Préférence : ${texte(f, "hotelPref")}` : null },
          { titre: "Agence", valeur: texte(f, "agence") ?? "Non précisée" },
        ],
        cles: ["villeDepart", "villeArrivee", "poste", "dateDepart", "dateRetour", "billet", "hotel", "nbNuits", "hotelPref", "agence"],
      };
    }
    case "MAIL":
      return {
        blocs: [
          { titre: "Destinataire", valeur: texte(f, "destinataire") ?? "Non précisé" },
          { titre: "Organisme", valeur: texte(f, "organisme") ?? "Non précisé" },
          { titre: "Objet", valeur: texte(f, "objet") ?? "Non précisé" },
          {
            titre: "Mode d'envoi", valeur: MODE_ENVOI[texte(f, "modeEnvoi") ?? ""] ?? texte(f, "modeEnvoi") ?? "Non précisé",
            detail: [oui(f, "signature") ? "signature nécessaire" : null, oui(f, "cachet") ? "cachet nécessaire" : null].filter(Boolean).join(" · ") || null,
          },
        ],
        cles: ["destinataire", "organisme", "objet", "modeEnvoi", "signature", "cachet"],
      };
    case "SIGNATURE":
      return {
        blocs: [
          { titre: "Document", valeur: texte(f, "documentConcerne") ?? "Non précisé" },
          { titre: "Action", valeur: ACTION_SIGNATURE[texte(f, "action") ?? ""] ?? texte(f, "action") ?? "Non précisée" },
          { titre: "Signataire", valeur: texte(f, "signataire") ?? "Non précisé" },
          { titre: "Exemplaires", valeur: texte(f, "exemplaires") ?? "—" },
        ],
        cles: ["documentConcerne", "action", "signataire", "exemplaires"],
      };
    case "PAYMENT":
      return {
        blocs: [
          { titre: "Bénéficiaire", valeur: texte(f, "beneficiaire") ?? "Non précisé", detail: texte(f, "typePaiement") },
          { titre: "Montant", valeur: montantLisible(texte(f, "montant"), texte(f, "devise")) ?? "Non précisé", detail: texte(f, "modePaiement") },
          { titre: "Date souhaitée", valeur: periodeCourte(texte(f, "datePaiement"), null) ?? "Non précisée" },
          { titre: "Facture", valeur: oui(f, "factureDispo") ? "Disponible" : "Pas encore" },
        ],
        cles: ["beneficiaire", "typePaiement", "montant", "devise", "modePaiement", "datePaiement", "factureDispo"],
      };
    case "PURCHASE":
      return {
        blocs: [
          { titre: "Article", valeur: texte(f, "article") ?? "Voir les articles demandés", detail: texte(f, "quantite") ? `Quantité : ${texte(f, "quantite")}` : null },
          { titre: "Fournisseur proposé", valeur: texte(f, "fournisseur") ?? "Aucun", detail: oui(f, "devisDispo") ? "devis déjà disponible" : null },
        ],
        cles: ["article", "quantite", "fournisseur", "devisDispo"],
      };
    case "QUOTE":
      return {
        blocs: [
          { titre: "Produit / service", valeur: texte(f, "produit") ?? "Non précisé", detail: texte(f, "quantite") ? `Quantité : ${texte(f, "quantite")}` : null },
          { titre: "Fournisseur cible", valeur: texte(f, "fournisseurCible") ?? "Aucun", detail: texte(f, "fournisseursAlt") ? `Autres : ${texte(f, "fournisseursAlt")}` : null },
        ],
        cles: ["produit", "quantite", "fournisseurCible", "fournisseursAlt"],
      };
    default:
      return null;
  }
}

/** LES BLOCS EN TÊTE — `[]` pour un type qui garde la liste générique. */
export function blocsDeLaDemande(type: string, fields: unknown): BlocDemande[] {
  const f = fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as Champs) : {};
  return blocsEtCles(type, f)?.blocs ?? [];
}

/** Les champs saisis qu'AUCUN bloc ne reprend — ils restent listés dans « La demande ». */
export function champsRestants(type: string, fields: unknown): string[] {
  const f = fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as Champs) : {};
  const repris = new Set(blocsEtCles(type, f)?.cles ?? []);
  return Object.keys(f).filter((k) => !repris.has(k));
}
