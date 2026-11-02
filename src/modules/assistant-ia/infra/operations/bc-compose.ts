import { prisma } from "@/lib/prisma";
import { emettreDocumentDrive, profilDocumentaire, type DemandeDocument } from "@/platform/ia/artifact/factory";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { ligneDeDetail, natureDeLaCommande, refusTransitionBC, sansRedite } from "../../domaine/operations/bc-devis";
import { enveloppeDuBC, finaliserBrouillonBC, peutPreparerUnBC } from "./bc-depuis-devis";
import { findPartyByName, validateur } from "./bon-de-commande";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BON DE COMMANDE COMPOSÉ SANS PIÈCE — « fais un BC à l'Imprimerie Atlas : 500 kakémonos à 2 000 DZD » (lot B1,
 * décision 0049 ; audit Q1, BC-03).
 *
 * `preparer_bon_de_commande` SOUMET un BC qui existe déjà en fichier ; `preparer_bc_depuis_devis` le compose depuis un
 * devis lu. Restait le BC que la personne DICTE : ses lignes sont les SIENNES (quantité, prix — jamais complétées par le
 * modèle), le fournisseur est celui de l'annuaire (ou son seul nom, dit sur la carte), la société celle de la personne.
 * Même geste et même cycle que depuis un devis : « Créer le BC (PDF) » → brouillon numéroté + PDF au Drive, sans
 * validateur ; l'envoi en validation est `envoyer_bc_en_validation`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface LigneDictee { designation: string; quantite: number; prixUnitaire: number; unite: string | null }

/** Les lignes dictées : une désignation, une quantité > 0, un prix ≥ 0 — rien n'est complété. */
export function lignesDictees(e: Record<string, unknown>): { lignes: LigneDictee[]; incompletes: string[] } {
  const brut = Array.isArray(e.lignes) ? e.lignes : [];
  const lignes: LigneDictee[] = [];
  const incompletes: string[] = [];
  brut.forEach((x, i) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const designation = typeof o.designation === "string" ? o.designation.trim() : "";
    const q = Number(o.quantite);
    const pu = Number(o.prixUnitaire);
    if (!designation) { incompletes.push(`la désignation de la ligne ${i + 1}`); return; }
    if (!Number.isFinite(q) || q <= 0) { incompletes.push(`la quantité de « ${designation} »`); return; }
    if (!Number.isFinite(pu) || pu < 0) { incompletes.push(`le prix unitaire HT de « ${designation} »`); return; }
    lignes.push({ designation, quantite: q, prixUnitaire: pu, unite: typeof o.unite === "string" && o.unite.trim() ? o.unite.trim() : null });
  });
  return { lignes, incompletes };
}

const c2 = (n: number) => Math.round(n * 100) / 100;

async function tiersDe(id: string | null, nom: string): Promise<NonNullable<DemandeDocument["tiers"]>> {
  if (id) {
    const f = await prisma.companyContact.findUnique({ where: { id }, select: { name: true, address: true, city: true, wilaya: true, rc: true, nif: true, rib: true, phone: true, email: true } });
    if (f) {
      const adresse = [f.address, [f.city, f.wilaya].filter(Boolean).join(", ")].filter((x) => x && x.trim()).join("\n") || null;
      return { nom: f.name, adresse, rc: f.rc, nif: f.nif, rib: f.rib, telephone: f.phone, email: f.email };
    }
  }
  return { nom, adresse: null, rc: null, nif: null, rib: null, telephone: null, email: null };
}

export const BC_COMPOSE: OperationIA = {
  nom: "composer_bon_de_commande",
  module: "VALIDATIONS",
  libelle: "Bon de commande composé",
  description:
    "COMPOSE un BON DE COMMANDE en PDF SANS pièce jointe, à partir de ce que l'utilisateur DICTE : le fournisseur et les lignes (désignation, quantité, "
    + "prix unitaire HT — ceux qu'il a dits, jamais complétés par toi). Le BC naît en BROUILLON avec son PDF (bouton « Créer le BC (PDF) ») ; le validateur "
    + "n'est PAS demandé (il se désigne à l'envoi en validation : `envoyer_bc_en_validation`). Un devis joint → `preparer_bc_depuis_devis` ; un BC déjà en "
    + "fichier à soumettre → `preparer_bon_de_commande`. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      fournisseur: { type: "string", description: "Le fournisseur, tel que l'utilisateur le nomme." },
      lignes: {
        type: "array",
        items: { type: "object", properties: { designation: { type: "string" }, quantite: { type: "number" }, prixUnitaire: { type: "number", description: "HT, DZD" }, unite: { type: "string" } } },
      },
      tva: { type: "number", description: "Taux de TVA en %, si l'utilisateur le donne (défaut : 19 %, taux normal, affiché sur la carte)." },
      objet: { type: "string" },
      societe: { type: "string", description: "La société qui commande, si l'utilisateur la précise." },
      enveloppe: { type: "string", description: "L'enveloppe budgétaire, si l'utilisateur en nomme une." },
      validateur: { type: "string", description: "Facultatif : retenu pour l'envoi en validation." },
    },
  },
  ouverte: peutPreparerUnBC,

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const nomFournisseur = texte(e, "fournisseur");
    const { lignes, incompletes } = lignesDictees(e);
    const manque = [
      !nomFournisseur ? "le fournisseur" : null,
      ...incompletes,
      !lignes.length && !incompletes.length ? "ce qu'il faut commander (désignation, quantité, prix unitaire HT)" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque: manque.slice(0, 1) };
    const refus = refusTransitionBC("CREER", null, { lignesChiffrees: true });
    if (refus) return { erreur: refus };

    const p = await profilDocumentaire(user, texte(e, "societe") || null, { type: "BON_DE_COMMANDE" });
    if (!p.ok) return p.candidats?.length ? { manque: [`au nom de quelle société : ${p.candidats.map((c) => c.nom).join(", ")}`] } : { erreur: p.motif };
    const nomVal = texte(e, "validateur");
    const val = nomVal ? await validateur(user, nomVal) : null;
    if (val && "manque" in val) return { manque: [val.manque] };
    const v = val as { id: string; nom: string } | null;

    const fiche = await findPartyByName(user.id, nomFournisseur);
    const tvaPct = nombre(e, "tva") ?? 19;
    if (tvaPct < 0 || tvaPct > 100) return { erreur: "Un taux de TVA se donne en pour cent, entre 0 et 100." };
    const ht = c2(lignes.reduce((s, l) => s + l.quantite * l.prixUnitaire, 0));
    const tva = c2(ht * tvaPct / 100);
    const ttc = c2(ht + tva);
    const objet = texte(e, "objet") || `Commande ${fiche.ok ? fiche.name : nomFournisseur}`;
    const nature = natureDeLaCommande([objet, ...lignes.map((l) => l.designation)]);
    const { env, champEnveloppe, avertissementEnveloppe } = await enveloppeDuBC(user, nature, texte(e, "enveloppe") || null, ttc);
    const fournisseur = fiche.ok ? fiche.name : nomFournisseur;
    const detail = lignes.map((l, i) => ligneDeDetail({ rang: i + 1, ...l }, dzd));

    return {
      carte: {
        title: `Bon de commande — ${fournisseur} → ${p.profil.societe.nom}`,
        fields: champs([
          ["Fournisseur", `${fournisseur}${fiche.ok ? " · dans l'annuaire" : " · hors annuaire (le BC porte son seul nom)"}`],
          ["Société", p.profil.societe.nom],
          ["Lignes", lignes.length <= 4 ? detail.join("\n") : `${lignes.length} lignes`],
          ["Total HT", dzd(ht)],
          ["TVA", `${tvaPct} % · ${dzd(tva)}${nombre(e, "tva") == null ? " (taux normal)" : ""}`],
          ["Total TTC", dzd(ttc)],
          ["Enveloppe proposée", champEnveloppe],
          ["Validateur", v ? `${v.nom} (à l'envoi en validation)` : "à désigner à l'envoi en validation"],
          ["Détail des lignes", lignes.length > 4 ? detail.join("\n") : null],
        ]),
        warnings: sansRedite([
          "Lignes et prix dictés par vous : le BC les reprend tels quels.",
          avertissementEnveloppe,
        ]),
        libelleBouton: "Créer le BC (PDF)",
      },
      args: {
        fournisseurId: fiche.ok ? fiche.id : null, fournisseur, societe: p.profil.societe.id, objet, tva: String(tvaPct),
        validatorId: v?.id ?? null, enveloppe: env ? JSON.stringify(env) : null, lignes: JSON.stringify(lignes),
      },
    };
  },

  async executer(a, user) {
    let lignes: LigneDictee[];
    try { lignes = JSON.parse(a.lignes ?? "[]"); } catch { return { ok: false, error: "Lignes illisibles." }; }
    if (!lignes.length) return { ok: false, error: "Aucune ligne à commander." };
    const emis = await emettreDocumentDrive(user, {
      type: "BON_DE_COMMANDE", societe: a.societe, tiers: await tiersDe(a.fournisseurId, a.fournisseur ?? ""), objet: a.objet,
      lignes: lignes.map((l) => ({ designation: l.designation, unite: l.unite, quantite: l.quantite, prixUnitaire: l.prixUnitaire })),
      tvaDefaut: Number(a.tva) / 100,
      prevalidation: true, dossier: "Bons de commande émis",
    }, { canal: "ADAM" });
    if (!emis.ok) return { ok: false, error: emis.motif + (emis.bloquants?.length ? ` — ${emis.bloquants.slice(0, 3).join(" ; ")}` : "") };
    return finaliserBrouillonBC(emis, a, { origine: "DICTE", nodeId: null, nom: null });
  },
};
