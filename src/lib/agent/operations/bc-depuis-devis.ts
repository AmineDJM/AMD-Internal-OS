import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { createValidationRequest } from "@/lib/actions/validation-actions";
import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC } from "@/lib/bons-de-commande/regle";
import { peutCreerUnBC } from "@/lib/bons-de-commande/retenue-bc";
import { emettreDocumentDrive, profilDocumentaire } from "@/platform/in-process/artifact/factory";
import type { PartieCommerciale } from "@/lib/artifact/factory/commercial";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive } from "./pieces";
import { lireDevis, type DevisLu, type LigneDuDevis } from "./devis-lu";
import { validateur } from "./bon-de-commande";
import { avertissementBudget } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BON DE COMMANDE COMPOSÉ DEPUIS UN DEVIS — lu, pré-rempli, confirmé, puis sa demande de validation.
 *
 * Le devis est LU par l'ERP (`lireDevis`) ; les lignes du bon de commande sont CELLES DE LA LECTURE
 * — le modèle ne fait que désigner le fichier, écarter une ligne ou compléter un chiffre illisible
 * que la personne lui dicte. Une TVA que le papier n'imprime pas n'est jamais supposée : elle se
 * demande. À la confirmation, la fabrique compose le BC sur le papier en-tête de la société
 * (`emettreDocumentDrive`, né EN PRÉ-VALIDATION, comme depuis l'écran « Composer »), puis l'action
 * de l'écran Validations ouvre la demande (`createValidationRequest`, source COMPOSER), le devis joint.
 *
 * Écrire le BC demande le droit d'écrire au registre (Legal ou Finances) — revérifié par la fabrique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Correction = { rang: number; quantite?: number; prixUnitaire?: number };

function corrections(e: Record<string, unknown>): Correction[] {
  const brut = Array.isArray(e.corrections) ? e.corrections : [];
  return brut.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const rang = Number(o.rang);
    if (!Number.isInteger(rang)) return [];
    const q = Number(o.quantite);
    const p = Number(o.prixUnitaire);
    return [{ rang, ...(Number.isFinite(q) && q > 0 ? { quantite: q } : {}), ...(Number.isFinite(p) && p >= 0 ? { prixUnitaire: p } : {}) }];
  });
}

const ecartees = (e: Record<string, unknown>): Set<number> =>
  new Set((Array.isArray(e.ecarter) ? e.ecarter : []).map(Number).filter(Number.isInteger));

/** Les lignes retenues : la lecture, moins les écartées, complétée des seuls chiffres dictés. */
export function lignesRetenues(d: Pick<DevisLu, "lignes">, e: Record<string, unknown>): LigneDuDevis[] {
  const exclues = ecartees(e);
  const parRang = new Map(corrections(e).map((c) => [c.rang, c]));
  return d.lignes.filter((l) => !exclues.has(l.rang)).map((l) => {
    const c = parRang.get(l.rang);
    return { ...l, quantite: c?.quantite ?? l.quantite, prixUnitaire: c?.prixUnitaire ?? l.prixUnitaire };
  });
}

/** Le fournisseur tel que le BC l'imprime : sa fiche de l'annuaire, sinon l'identité recopiée du devis. */
async function tiersDuFournisseur(d: DevisLu): Promise<PartieCommerciale | null> {
  if (d.fournisseur.id) {
    const f = await prisma.companyContact.findUnique({
      where: { id: d.fournisseur.id },
      select: { name: true, address: true, city: true, wilaya: true, rc: true, nif: true, rib: true, phone: true, email: true },
    });
    if (f) {
      const adresse = [f.address, [f.city, f.wilaya].filter(Boolean).join(", ")].filter((x) => x && x.trim()).join("\n") || null;
      return { nom: f.name, adresse, rc: f.rc, nif: f.nif, rib: f.rib, telephone: f.phone, email: f.email };
    }
  }
  const lu = d.emetteur;
  return lu.nom ? { nom: lu.nom, adresse: lu.adresse, rc: lu.rc, nif: lu.nif, rib: lu.rib, telephone: lu.telephone, email: lu.email } : null;
}

const ligneDeCarte = (l: LigneDuDevis) =>
  `${l.rang}. ${l.quantite} × ${l.designation}${l.unite ? ` (${l.unite})` : ""} à ${dzd(l.prixUnitaire!)} HT = ${dzd(Math.round(l.quantite! * l.prixUnitaire! * 100) / 100)}`;

export const BC_DEPUIS_DEVIS: OperationIA = {
  nom: "preparer_bc_depuis_devis",
  module: "VALIDATIONS",
  libelle: "Bon de commande composé depuis un devis",
  description:
    "COMPOSE un BON DE COMMANDE à partir d'un DEVIS (fichier du Drive ou glissé dans la conversation) : les lignes, les prix et le fournisseur viennent "
    + "de la LECTURE du devis par l'ERP, pas de toi. Puis ouvre sa demande de validation (bouton « Créer la demande de validation »). Tu peux écarter "
    + "des lignes (`ecarter` : leurs numéros) ou compléter un chiffre illisible QUE L'UTILISATEUR T'A DONNÉ (`corrections`). Elle répond `manque` — pose "
    + "alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      fichier: { type: "string", description: "Le devis : nom ou identifiant du fichier." },
      validateur: { type: "string", description: "Le validateur principal (nom d'un collègue)." },
      objet: { type: "string", description: "Objet de la commande (facultatif : déduit du devis)." },
      tva: { type: "number", description: "Taux de TVA en %, SEULEMENT si l'utilisateur le donne (le devis n'en imprime pas)." },
      societe: { type: "string", description: "La société qui commande, si l'utilisateur la précise." },
      ecarter: { type: "array", items: { type: "number" }, description: "Numéros des lignes du devis à ne pas commander." },
      corrections: {
        type: "array",
        description: "Chiffres illisibles complétés par l'utilisateur.",
        items: { type: "object", properties: { rang: { type: "number" }, quantite: { type: "number" }, prixUnitaire: { type: "number", description: "HT, DZD" } } },
      },
      description: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "VALIDATIONS", "CREATE") && peutCreerUnBC(u),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    if (!texte(e, "fichier")) return { manque: ["le devis : glissez-le dans la conversation ou nommez-le dans le Drive"] };
    const d = await lireDevis(user, texte(e, "fichier"));
    if ("erreur" in d) return { erreur: d.erreur };
    if (!d.lignes.length) return { erreur: `Aucune ligne n'a pu être lue sur « ${d.piece.nom} ». ${d.sansLignes ?? ""} Composez le bon de commande depuis l'écran Validations › Composer.`.trim() };

    const lignes = lignesRetenues(d, e);
    if (!lignes.length) return { erreur: "Toutes les lignes du devis ont été écartées : il n'y a rien à commander." };
    const tvaPct = nombre(e, "tva") ?? d.tvaPct;
    const val = await validateur(user, texte(e, "validateur"));
    const manque = [
      ...lignes.filter((l) => l.quantite == null).map((l) => `la quantité de la ligne ${l.rang} « ${l.designation} » (illisible sur le devis)`),
      ...lignes.filter((l) => l.prixUnitaire == null).map((l) => `le prix unitaire HT de la ligne ${l.rang} « ${l.designation} » (illisible, remisé ou dans une autre devise)`),
      tvaPct == null ? "le taux de TVA (le devis n'en imprime pas) : 19 %, 9 % ou 0 %" : null,
      !d.fournisseur.nom ? (d.fournisseur.candidats.length ? `quel fournisseur : ${d.fournisseur.candidats.join(", ")}` : "le fournisseur (le devis ne le nomme pas lisiblement)") : null,
      "manque" in val ? val.manque : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    if (tvaPct! < 0 || tvaPct! > 100) return { erreur: "Un taux de TVA se donne en pour cent, entre 0 et 100." };
    const v = val as { id: string; nom: string };

    const p = await profilDocumentaire(user, texte(e, "societe") || null, { type: "BON_DE_COMMANDE" });
    if (!p.ok) return p.candidats?.length ? { manque: [`au nom de quelle société : ${p.candidats.map((c) => c.nom).join(", ")}`] } : { erreur: p.motif };

    const ht = Math.round(lignes.reduce((s, l) => s + l.quantite! * l.prixUnitaire!, 0) * 100) / 100;
    const ttc = Math.round(ht * (1 + tvaPct! / 100 + (d.taxe ? d.taxe.pct / 100 : 0)) * 100) / 100;
    const objet = texte(e, "objet") || `Commande ${d.fournisseur.nom}${d.numero ? ` — devis ${d.numero}` : ""}`;

    const seuil = (await getAppSettings()).bcValidationThresholdCentre;
    const warnings = [
      "Lignes LUES sur le devis par la machine : vérifiez chacune contre le papier avant de confirmer.",
      ...d.doutes.map((x) => `Contrôle des totaux : ${x}`),
      ...lignes.flatMap((l) => l.aVerifier.map((x) => `Ligne ${l.rang} : ${x}`)),
      d.totalHtImprime != null && Math.abs(d.totalHtImprime - ht) > 0.5 && !ecartees(e).size
        ? `Le total HT imprimé (${dzd(d.totalHtImprime)}) ne fait pas celui des lignes (${dzd(ht)}).` : null,
      d.fournisseur.id ? null : `« ${d.fournisseur.nom} » n'est pas dans votre annuaire : le BC porte l'identité recopiée du devis.`,
      nombre(e, "tva") != null && d.tvaPct == null ? `TVA ${tvaPct} % : donnée par vous, le devis n'en imprime pas.` : null,
      validationRequiseBC(ttc, seuil)
        ? `Au-dessus du seuil de ${dzd(seuil)} : après le validateur, le bon de commande passe par le centre de validation, puis par la SIGNATURE DES FINANCES.`
        : `Sous le seuil de ${dzd(seuil)} : après le validateur, il passe directement à la SIGNATURE DES FINANCES.`,
      await avertissementBudget(user, ttc),
    ].filter((x): x is string => Boolean(x));

    return {
      carte: {
        title: `Bon de commande — ${d.fournisseur.nom}`,
        fields: champs([
          ["Devis", `${d.piece.nom}${d.numero ? ` · n° ${d.numero}` : ""}${d.date ? ` du ${d.date}` : ""}`],
          ["Fournisseur", d.fournisseur.nom],
          ["Lignes", lignes.map(ligneDeCarte).join("\n")],
          ["Total HT", dzd(ht)],
          ["TVA", `${tvaPct} %${d.taxe ? ` · ${d.taxe.libelle} ${d.taxe.pct} %` : ""}`],
          ["Total TTC estimé", dzd(ttc)],
          ["Société", p.profil.societe.nom],
          ["Validateur", v.nom],
          ["Objet", objet],
        ]),
        warnings,
        libelleBouton: "Créer la demande de validation",
      },
      args: {
        fichier: d.piece.id, empreinte: d.empreinte, societe: p.profil.societe.id, validatorId: v.id, objet,
        description: texte(e, "description") || null, tva: String(tvaPct),
        lignes: JSON.stringify(lignes.map((l) => ({ designation: l.designation, unite: l.unite, quantite: l.quantite, prixUnitaire: l.prixUnitaire }))),
      },
    };
  },

  async executer(a, user) {
    // Le devis est RELU (droits revérifiés, lecture en cache) : celui de la carte, pas un autre.
    const d = await lireDevis(user, a.fichier ?? "");
    if ("erreur" in d) return { ok: false, error: d.erreur };
    if (d.empreinte !== a.empreinte) return { ok: false, error: "Le devis a changé depuis la carte : redemandez le bon de commande." };
    const tiers = await tiersDuFournisseur(d);
    if (!tiers) return { ok: false, error: "Le fournisseur du devis n'est plus identifiable." };
    let lignes: { designation: string; unite: string | null; quantite: number; prixUnitaire: number }[];
    try { lignes = JSON.parse(a.lignes ?? "[]"); } catch { return { ok: false, error: "Lignes illisibles." }; }
    const emis = await emettreDocumentDrive(user, {
      type: "BON_DE_COMMANDE", societe: a.societe, tiers, objet: a.objet,
      lignes: lignes.map((l) => ({ designation: l.designation, unite: l.unite, quantite: l.quantite, prixUnitaire: l.prixUnitaire })),
      tvaDefaut: Number(a.tva) / 100,
      taxes: d.taxe ? [{ libelle: d.taxe.libelle, taux: d.taxe.pct / 100 }] : null,
      referenceAmont: d.numero, referenceAmontDate: d.date,
      prevalidation: true, dossier: "Bons de commande émis",
    });
    if (!emis.ok) return { ok: false, error: emis.motif + (emis.bloquants?.length ? ` — ${emis.bloquants.slice(0, 3).join(" ; ")}` : "") };

    const fd = new FormData();
    fd.set("objectKind", "BON_DE_COMMANDE");
    fd.set("bcSource", "COMPOSER");
    fd.set("legalDocumentId", emis.legalDocumentId);
    fd.set("title", a.objet ?? `Bon de commande ${emis.reference}`);
    fd.set("validatorId", a.validatorId ?? "");
    if (a.description) fd.set("description", a.description);
    const devis = await fichiersDepuisDrive(user, [d.piece.id]);
    if (Array.isArray(devis) && devis[0]) fd.append("files", devis[0]);
    const r = await createValidationRequest(undefined, fd);
    const lien = `/legal/${emis.legalDocumentId}`;
    if (!r.ok) {
      return { ok: false, error: `Bon de commande ${emis.reference} ${emis.dejaEmis ? "déjà émis" : "émis"} (en pré-validation, ${lien}), mais la demande de validation a été refusée : ${r.error ?? "raison non précisée"}.` };
    }
    return {
      ok: true, link: "/validations",
      message: `Bon de commande ${emis.reference} composé sur le papier de ${emis.societe.nom} (${dzd(emis.totaux.totalTtc)} TTC) ; ${r.message ?? "demande de validation créée."}`,
      revalidate: ["/validations", "/legal"],
    };
  },
};
