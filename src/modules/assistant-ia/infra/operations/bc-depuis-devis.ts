import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { peutAnnuaire, userCan } from "@/lib/rbac";
import { createValidationRequest } from "@/lib/actions/validation-actions";
import { createCompanyContact } from "@/lib/actions/company-contact-actions";
import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC } from "@/lib/bons-de-commande/regle";
import { peutCreerUnBC } from "@/lib/bons-de-commande/retenue-bc";
import { emettreDocumentDrive, profilDocumentaire } from "@/platform/ia/artifact/factory";
import type { PartieCommerciale } from "@/lib/artifact/factory/commercial";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import {
  LIBELLE_NATURE, ligneDeDetail, natureDeLaCommande, phraseProvenance, phraseTaxes, sansRedite,
} from "../../domaine/operations/bc-devis";
import { fichiersDepuisDrive } from "./pieces";
import { lireDevis, phraseReconciliation, type DevisLu, type LigneDuDevis } from "./devis-lu";
import { enveloppeProposee } from "./budget";
import { ficheVisible } from "./demandes-visibles";
import { validateur } from "./bon-de-commande";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CRÉE UN BC EN PDF » DEPUIS UN DEVIS — lu, composé, créé en BROUILLON avec son PDF (lot B1, décision 0049).
 *
 * Le devis est LU par l'ERP (`lireDevis` : le tableau par ses positions, sinon le modèle, puis la
 * vision en seconde passe si la somme des lignes ne fait pas le HT imprimé). Les lignes du BC sont
 * CELLES DE LA LECTURE — le modèle ne fait que désigner le fichier, écarter une ligne ou compléter un
 * chiffre que la personne lui dicte.
 *
 * ── CE QU'ON NE DEMANDE PLUS (la conversation de la Direction, 02/11) ─────────────────────
 *   • le VALIDATEUR : il se désigne quand on ENVOIE le BC en validation (`ENVOI_BC_VALIDATION`),
 *     pas pour le créer — « on verra plus tard qui le valide » est une réponse acceptée ;
 *   • la SOCIÉTÉ : c'est le CLIENT du devis (Adventum, Pharmagène, AMD Life Sciences), lu sur le
 *     papier — demandée seulement si le papier n'en nomme aucune et que la personne en a plusieurs ;
 *   • l'ENVELOPPE : proposée selon la NATURE (du matériel promotionnel → l'enveloppe promo/marketing),
 *     changeable (`enveloppe`).
 * Ce qui bloque vraiment se demande encore, une question à la fois : un chiffre illisible, une TVA
 * que le papier n'imprime pas, un fournisseur que rien ne nomme.
 *
 * ── LE GESTE : « Créer le BC (PDF) » ───────────────────────────────────────────────────────
 * La fabrique compose le BC sur le papier de la société (`emettreDocumentDrive`) : numéroté selon la
 * règle des pièces, en PRÉ-VALIDATION (aucun centre ne le prend tant qu'il n'est pas envoyé), son
 * .docx et son PDF déposés au Drive — le lien du PDF revient dans la conversation. Réversible (K10b) :
 * annulé, le BC passe à ANNULÉ, son numéro reste consommé, ses fichiers restent au Drive.
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
async function tiersDuFournisseur(d: DevisLu, ficheId: string | null): Promise<PartieCommerciale | null> {
  const id = ficheId ?? d.fournisseur.id;
  if (id) {
    const f = await prisma.companyContact.findUnique({
      where: { id },
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

const c2 = (n: number) => Math.round(n * 100) / 100;

export const BC_DEPUIS_DEVIS: OperationIA = {
  nom: "preparer_bc_depuis_devis",
  module: "VALIDATIONS",
  libelle: "Bon de commande créé depuis un devis",
  description:
    "CRÉE un BON DE COMMANDE en PDF à partir d'un DEVIS (fichier du Drive ou glissé dans la conversation) : les lignes, les prix, le fournisseur (l'ÉMETTEUR du devis) "
    + "et la société (le CLIENT du devis) viennent de la LECTURE du devis par l'ERP, pas de toi. Le BC est créé en BROUILLON avec son PDF (bouton « Créer le BC (PDF) ») ; "
    + "le VALIDATEUR n'est PAS demandé ici — il se désigne à l'envoi en validation (`envoyer_bc_en_validation`). Ne demande jamais le validateur ni la société "
    + "avant d'avoir appelé cette opération. Tu peux écarter des lignes (`ecarter`), compléter un chiffre illisible QUE L'UTILISATEUR T'A DONNÉ (`corrections`), "
    + "changer l'enveloppe (`enveloppe`). Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      fichier: { type: "string", description: "Le devis : nom ou identifiant du fichier." },
      objet: { type: "string", description: "Objet de la commande (facultatif : déduit du devis)." },
      tva: { type: "number", description: "Taux de TVA en %, SEULEMENT si l'utilisateur le donne (le devis n'en imprime pas)." },
      societe: { type: "string", description: "La société qui commande, SEULEMENT si l'utilisateur la précise (sinon : le client du devis)." },
      enveloppe: { type: "string", description: "L'enveloppe budgétaire, SEULEMENT si l'utilisateur en nomme une (sinon : proposée selon la nature)." },
      validateur: { type: "string", description: "Facultatif : le validateur, si l'utilisateur l'a déjà nommé — retenu pour l'envoi en validation." },
      creer_fiche: { type: "boolean", description: "Faux si l'utilisateur ne veut PAS que la fiche du fournisseur soit créée à l'annuaire." },
      ecarter: { type: "array", items: { type: "number" }, description: "Numéros des lignes du devis à ne pas commander." },
      corrections: {
        type: "array",
        description: "Chiffres illisibles complétés par l'utilisateur.",
        items: { type: "object", properties: { rang: { type: "number" }, quantite: { type: "number" }, prixUnitaire: { type: "number", description: "HT, DZD" } } },
      },
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
    // UNE question à la fois, et seulement ce qui bloque vraiment la composition du BC.
    const manque = [
      ...lignes.filter((l) => l.quantite == null).map((l) => `la quantité de la ligne ${l.rang} « ${l.designation} » (illisible sur le devis)`),
      ...lignes.filter((l) => l.prixUnitaire == null).map((l) => `le prix unitaire HT de la ligne ${l.rang} « ${l.designation} » (illisible, remisé ou dans une autre devise)`),
      tvaPct == null ? "le taux de TVA (le devis n'en imprime pas) : 19 %, 9 % ou 0 %" : null,
      !d.fournisseur.nom ? (d.fournisseur.candidats.length ? `quel fournisseur : ${d.fournisseur.candidats.join(", ")}` : "le fournisseur (le devis ne le nomme pas lisiblement)") : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque: manque.slice(0, 1) };
    if (tvaPct! < 0 || tvaPct! > 100) return { erreur: "Un taux de TVA se donne en pour cent, entre 0 et 100." };

    // LA SOCIÉTÉ : celle que la personne nomme, sinon le CLIENT du devis, sinon la sienne (une seule) — demandée en dernier recours.
    const p = await profilDocumentaire(user, texte(e, "societe") || d.destinataireId || null, { type: "BON_DE_COMMANDE" });
    if (!p.ok) return p.candidats?.length ? { manque: [`au nom de quelle société : ${p.candidats.map((c) => c.nom).join(", ")}`] } : { erreur: p.motif };
    const societeDuDevis = !texte(e, "societe") && d.destinataireId === p.profil.societe.id;

    // LE VALIDATEUR, s'il est déjà nommé : retenu pour l'envoi. Absent : rien n'est demandé.
    const nomVal = texte(e, "validateur");
    const val = nomVal ? await validateur(user, nomVal) : null;
    if (val && "manque" in val) return { manque: [val.manque] };
    const v = val as { id: string; nom: string } | null;

    const ht = c2(lignes.reduce((s, l) => s + l.quantite! * l.prixUnitaire!, 0));
    const tva = c2(ht * tvaPct! / 100);
    const taxe = d.taxe ? c2(ht * d.taxe.pct / 100) : 0;
    const ttc = c2(ht + tva + taxe);
    const objet = texte(e, "objet") || `Commande ${d.fournisseur.nom}${d.numero ? ` — devis ${d.numero}` : ""}`;
    const nature = natureDeLaCommande([objet, d.piece.nom, ...lignes.map((l) => l.designation)]);
    const env = await enveloppeProposee(user, nature, texte(e, "enveloppe") || null);
    if (texte(e, "enveloppe") && !env) return { manque: [`quelle enveloppe : « ${texte(e, "enveloppe")} » n'est pas parmi celles que vous voyez`] };

    const fiche = d.fournisseur.id ? null : d.aCreer ?? null;
    const peutCreerFiche = !!fiche?.nom && peutAnnuaire(user, "PARTENAIRES", "CREATE");
    const creerFiche = peutCreerFiche && e.creer_fiche !== false;
    const toutesLues = ecartees(e).size === 0 && corrections(e).length === 0;

    const warnings = sansRedite([
      phraseProvenance(d.methodeLignes),
      toutesLues && d.reconciliation ? phraseReconciliation(d.reconciliation, dzd) : null,
      ...(toutesLues && !d.reconciliation ? d.doutes.slice(0, 1) : []),
      toutesLues ? phraseTaxes({ tva, taxe, ttc }, d.imprime, dzd) : null,
      nombre(e, "tva") != null && d.tvaPct == null ? `TVA ${tvaPct} % : donnée par vous, le devis n'en imprime pas.` : null,
      env?.reste != null && ttc > env.reste ? `${dzd(ttc)} dépasse le disponible de l'enveloppe « ${env.nom} » (${dzd(env.reste)}) — la Direction arbitrera.` : null,
    ]);

    const fournisseurAffiche = `${d.fournisseur.nom}${d.emetteur.nif ? ` · NIF ${d.emetteur.nif}` : ""}${d.fournisseur.id ? " · dans l'annuaire" : creerFiche ? " · fiche créée à l'annuaire" : " · hors annuaire"}`;
    return {
      carte: {
        title: `Bon de commande — ${d.fournisseur.nom} → ${p.profil.societe.nom}`,
        fields: champs([
          ["Fournisseur", fournisseurAffiche],
          ["Société", `${p.profil.societe.nom}${societeDuDevis ? " (client du devis)" : ""}`],
          ["Devis", `${d.piece.nom}${d.numero ? ` · n° ${d.numero}` : ""}${d.date ? ` du ${d.date}` : ""}`],
          ["Lignes", `${lignes.length} ligne${lignes.length > 1 ? "s" : ""}${lignes.length !== d.lignes.length ? ` (sur ${d.lignes.length})` : ""}`],
          ["Total HT", dzd(ht)],
          ["TVA", `${tvaPct} % · ${dzd(tva)}${d.taxe ? ` — ${d.taxe.libelle} ${d.taxe.pct} % · ${dzd(taxe)}` : ""}`],
          ["Total TTC", dzd(ttc)],
          ["Enveloppe proposée", env ? `${env.nom} (${LIBELLE_NATURE[nature]}${env.reste != null ? ` · disponible ${dzd(env.reste)}` : ""})` : null],
          ["Validateur", v ? `${v.nom} (à l'envoi en validation)` : "à désigner à l'envoi en validation"],
          ["Détail des lignes", lignes.map((l) => ligneDeDetail(l, dzd)).join("\n")],
        ]),
        warnings,
        libelleBouton: "Créer le BC (PDF)",
      },
      args: {
        fichier: d.piece.id, empreinte: d.empreinte, societe: p.profil.societe.id, objet,
        tva: String(tvaPct), validatorId: v?.id ?? null, enveloppe: env ? JSON.stringify({ id: env.id, nom: env.nom }) : null,
        creerFiche: creerFiche ? "1" : null,
        lignes: JSON.stringify(lignes.map((l) => ({ designation: l.designation, unite: l.unite, quantite: l.quantite, prixUnitaire: l.prixUnitaire }))),
      },
    };
  },

  async executer(a, user) {
    // Le devis est RELU (droits revérifiés, lecture en cache) : celui de la carte, pas un autre.
    const d = await lireDevis(user, a.fichier ?? "");
    if ("erreur" in d) return { ok: false, error: d.erreur };
    if (d.empreinte !== a.empreinte) return { ok: false, error: "Le devis a changé depuis la carte : redemandez le bon de commande." };
    let ficheId: string | null = null;
    if (a.creerFiche && !d.fournisseur.id && d.aCreer?.nom && peutAnnuaire(user, "PARTENAIRES", "CREATE")) {
      const fd = new FormData();
      fd.set("name", d.aCreer.nom);
      fd.set("kind", "Fournisseur");
      for (const [k, v] of [["nif", d.emetteur.nif], ["rc", d.emetteur.rc], ["address", d.emetteur.adresse], ["phone", d.emetteur.telephone], ["email", d.emetteur.email]] as const) if (v) fd.set(k, v);
      fd.set("companyId", a.societe ?? "");
      fd.set("notes", `Créée depuis le devis « ${d.piece.nom} » (lecture du papier).`);
      const r = await createCompanyContact(undefined, fd);
      if (r.ok && "id" in r && typeof r.id === "string") ficheId = r.id;
    }
    const tiers = await tiersDuFournisseur(d, ficheId);
    if (!tiers) return { ok: false, error: "Le fournisseur du devis n'est plus identifiable." };
    let lignes: { designation: string; unite: string | null; quantite: number; prixUnitaire: number }[];
    try { lignes = JSON.parse(a.lignes ?? "[]"); } catch { return { ok: false, error: "Lignes illisibles." }; }
    const emis = await emettreDocumentDrive(user, {
      type: "BON_DE_COMMANDE", societe: a.societe, tiers, objet: a.objet,
      lignes: lignes.map((l) => ({ designation: l.designation, unite: l.unite, quantite: l.quantite, prixUnitaire: l.prixUnitaire })),
      tvaDefaut: Number(a.tva) / 100,
      taxes: d.taxe ? [{ libelle: d.taxe.libelle, taux: d.taxe.pct / 100 }] : null,
      referenceAmont: d.numero, referenceAmontDate: d.date,
      // EN PRÉ-VALIDATION : le brouillon n'est aiguillé vers aucun centre tant qu'il n'est pas envoyé en validation.
      prevalidation: true, dossier: "Bons de commande émis",
    }, { canal: "ADAM" });
    if (!emis.ok) return { ok: false, error: emis.motif + (emis.bloquants?.length ? ` — ${emis.bloquants.slice(0, 3).join(" ; ")}` : "") };

    // Ce que l'envoi en validation reprendra : le devis lu, l'enveloppe, le validateur déjà nommé.
    let env: { id: string; nom: string } | null = null;
    try { env = a.enveloppe ? JSON.parse(a.enveloppe) : null; } catch { env = null; }
    const doc = await prisma.legalDocument.findUnique({ where: { id: emis.legalDocumentId }, select: { custom: true, notes: true } });
    const custom = (doc?.custom && typeof doc.custom === "object" ? doc.custom : {}) as Record<string, unknown>;
    await prisma.legalDocument.update({
      where: { id: emis.legalDocumentId },
      data: {
        custom: { ...custom, depuisDevis: { nodeId: d.piece.id, nom: d.piece.nom, empreinte: d.empreinte, lecture: d.methodeLignes ?? null, enveloppe: env, validatorId: a.validatorId ?? null } } as unknown as Prisma.InputJsonValue,
        ...(env ? { notes: `${doc?.notes ?? ""}${doc?.notes ? "\n" : ""}Enveloppe proposée : ${env.nom}.` } : {}),
      },
    });
    const pdf = emis.pdf ? `/api/drive/${encodeURIComponent(emis.pdf.nodeId)}/raw` : null;
    return {
      ok: true, link: pdf ?? `/legal/${emis.legalDocumentId}`,
      message: `BC ${emis.reference} ${emis.dejaEmis ? "déjà émis" : "créé en brouillon"} sur le papier de ${emis.societe.nom} (${dzd(emis.totaux.totalTtc)} TTC)`
        + `${emis.pdf ? ` — PDF « ${emis.pdf.nom} » déposé au Drive (Bons de commande émis)` : " — le PDF n'a pas pu être produit, le .docx est au Drive"}.`
        + " Pour l'envoyer en validation : « envoie-le en validation » (validateur à désigner).",
      revalidate: ["/legal", "/drive"],
    };
  },
};

// ─────────────────────────────── L'envoi en validation — un geste séparé ───────────────────────────────

async function bcDesigne(user: CurrentUser, ref: string) {
  const r = ref.trim();
  const doc = await prisma.legalDocument.findFirst({
    where: { kind: "PURCHASE_ORDER", status: { not: "CANCELLED" }, OR: [{ id: r }, { reference: r }] },
    select: { id: true, reference: true, amount: true, counterparty: true, custom: true, companyId: true, createdById: true },
    orderBy: { createdAt: "desc" },
  }) ?? (r ? null : await prisma.legalDocument.findFirst({
    // Sans référence : le dernier BC brouillon que CETTE personne a créé depuis un devis.
    where: { kind: "PURCHASE_ORDER", status: { not: "CANCELLED" }, createdById: user.id, custom: { path: ["depuisDevis", "nodeId"], not: Prisma.AnyNull } },
    select: { id: true, reference: true, amount: true, counterparty: true, custom: true, companyId: true, createdById: true },
    orderBy: { createdAt: "desc" },
  }));
  if (!doc || !(await ficheVisible(user, "LEGAL_DOCUMENT", doc.id))) return null;
  return doc;
}

export const ENVOI_BC_VALIDATION: OperationIA = {
  nom: "envoyer_bc_en_validation",
  module: "VALIDATIONS",
  libelle: "Bon de commande envoyé en validation",
  description:
    "ENVOIE EN VALIDATION un bon de commande déjà créé (brouillon composé depuis un devis, ou BC émis) : ouvre sa demande de validation au validateur désigné, "
    + "le devis et le PDF joints. `bc` : sa référence (vide = le dernier BC créé depuis un devis). Le validateur est demandé ici s'il manque. Elle répond `manque` — UNE seule question.",
  schema: {
    type: "object",
    properties: {
      bc: { type: "string", description: "La référence du BC (ex. 012/DG/2026) ; vide = le dernier créé depuis un devis." },
      validateur: { type: "string", description: "Le validateur principal (nom d'un collègue)." },
      description: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "VALIDATIONS", "CREATE") && peutCreerUnBC(u),

  async proposer(e, user) {
    const doc = await bcDesigne(user, texte(e, "bc"));
    if (!doc) return { erreur: texte(e, "bc") ? `Aucun bon de commande « ${texte(e, "bc")} » que vous voyez.` : "Aucun bon de commande créé depuis un devis à envoyer : créez-le d'abord." };
    const dep = ((doc.custom as Record<string, unknown> | null)?.depuisDevis ?? null) as { validatorId?: string | null; nom?: string; enveloppe?: { nom: string } | null } | null;
    let v: { id: string; nom: string } | null = null;
    if (texte(e, "validateur")) {
      const r = await validateur(user, texte(e, "validateur"));
      if ("manque" in r) return { manque: [r.manque] };
      v = r;
    } else if (dep?.validatorId) {
      const u = await prisma.user.findUnique({ where: { id: dep.validatorId }, select: { id: true, name: true, isActive: true } });
      if (u?.isActive) v = { id: u.id, nom: u.name };
    }
    if (!v) return { manque: ["qui doit valider ce bon de commande (le validateur principal)"] };
    const ttc = Number(doc.amount ?? 0);
    const seuil = (await getAppSettings()).bcValidationThresholdCentre;
    // Sans seuil réglé (0), rien à dire : on n'annonce pas « au-dessus du seuil de 0 DZD ».
    const circuit = seuil > 0
      ? validationRequiseBC(ttc, seuil)
        ? `Au-dessus du seuil de ${dzd(seuil)} : après le validateur, le centre de validation, puis la signature des Finances.`
        : `Sous le seuil de ${dzd(seuil)} : après le validateur, la signature des Finances.`
      : null;
    return {
      carte: {
        title: `Envoyer en validation — BC ${doc.reference ?? ""}`.trim(),
        fields: champs([
          ["Bon de commande", doc.reference], ["Fournisseur", doc.counterparty], ["Total TTC", dzd(ttc)],
          ["Validateur", v.nom], ["Devis joint", dep?.nom ?? null], ["Enveloppe", dep?.enveloppe?.nom ?? null],
        ]),
        warnings: circuit ? [circuit] : [],
        libelleBouton: "Envoyer en validation",
      },
      args: { legalDocumentId: doc.id, validatorId: v.id, titre: `Bon de commande ${doc.reference ?? ""} — ${doc.counterparty ?? ""}`.trim(), description: texte(e, "description") || null },
    };
  },

  async executer(a, user) {
    const doc = await bcDesigne(user, a.legalDocumentId ?? "");
    if (!doc) return { ok: false, error: "Ce bon de commande n'existe plus (ou a été annulé)." };
    const dep = ((doc.custom as Record<string, unknown> | null)?.depuisDevis ?? null) as { nodeId?: string } | null;
    const fd = new FormData();
    fd.set("objectKind", "BON_DE_COMMANDE");
    fd.set("bcSource", "COMPOSER");
    fd.set("legalDocumentId", doc.id);
    fd.set("title", a.titre ?? `Bon de commande ${doc.reference}`);
    fd.set("validatorId", a.validatorId ?? "");
    if (a.description) fd.set("description", a.description);
    if (dep?.nodeId) {
      const devis = await fichiersDepuisDrive(user, [dep.nodeId]);
      if (Array.isArray(devis) && devis[0]) fd.append("files", devis[0]);
    }
    const r = await createValidationRequest(undefined, fd);
    if (!r.ok) return { ok: false, error: `La demande de validation du BC ${doc.reference} a été refusée : ${r.error ?? "raison non précisée"}.` };
    return { ok: true, link: "/validations", message: `BC ${doc.reference} envoyé en validation ; ${r.message ?? "le validateur est prévenu."}`, revalidate: ["/validations", "/legal"] };
  },
};
