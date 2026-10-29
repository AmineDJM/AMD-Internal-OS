import { randomUUID } from "crypto";
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveFile } from "@/lib/storage";
import { callLuna, lunaModel } from "@/lib/openai-luna";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { composerDocx, paragraphe, MIME_DOCX } from "@/lib/artifact/factory/word";
import { profilDocumentaire, resoudreSociete } from "@/platform/ia/artifact/factory";
import type { CurrentUser } from "@/lib/session";
import { anneeDuRegistre, attribuerAuRegistre, registreDe, verifierReferenceLibre } from "@/lib/references/registre-serveur";
import {
  ETAPE_DEMANDE_DEVIS, lettreDeSecours, lettreValide, texteDeLaLettre, quantiteEnLettre,
  type ArticleADeviser, type LettreDevis,
} from "@/modules/ad-pro/partage";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE DE DEVIS, RÉDIGÉE PAR LUNA ET POSÉE SUR LE PAPIER EN-TÊTE (Direction, 07/10).
 *
 * « Une demande générique (Word/PDF) en mode bonjour, nous aimerions avoir un devis sur… — document avec en-tête — powered
 * by Luna, très low cost mais très smart et très bien formée sur les demandes de matériel promotionnel. »
 *
 *   1. RÉDIGER — Luna (palier économique, une réponse au schéma strict, ~2 000 jetons) ; sa lettre n'est retenue que si
 *      `lettreValide` l'accepte (une puce par article, chaque quantité recopiée) ; sinon, et si elle tarde, la lettre de
 *      secours, écrite sans modèle. La demande de devis part TOUJOURS — Luna l'améliore, elle ne la conditionne pas.
 *   2. COMPOSER — le Word sur le papier en-tête de la société (`composerDocx`, le compositeur de la fabrique), puis le PDF
 *      (`docxToPdf`, le moteur de mise en page qui reproduit Word).
 *   3. DÉPOSER — PDF et Word sur chaque objet visé (le dossier ou le poste, et la demande au secrétariat), sous l'étape
 *      `DEMANDE_DEVIS` : la barre d'étapes du poste et la carte du dossier les retrouvent là.
 *
 * Hors des domaines, à dessein (comme `ordre-mission-depot.ts`) : c'est l'orchestration qui touche au fournisseur (Luna),
 * au stockage et à la fabrique — la rédaction et ses garde-fous vivent, purs, dans `ad-pro/demande-devis-lettre.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, la lettre de secours part : on n'attend pas Luna plus longtemps qu'un clic patient. */
const DELAI_LUNA_MS = 25_000;

const SYSTEME = `Tu es l'assistante achats marketing d'Adventum Pharma, laboratoire pharmaceutique algérien. Tu rédiges des DEMANDES DE DEVIS adressées à des agences et fournisseurs : matériel promotionnel (brochures, dépliants, kakémonos, PLV, présentoirs, objets publicitaires, cadeaux d'entreprise brandés, goodies, textiles, coffrets), et prestations d'événements (stands, traiteur, hébergement, impression, transport).

RÈGLES IMPÉRATIVES
- Réponds UNIQUEMENT par l'objet JSON du schéma, en français, vouvoiement, ton professionnel, courtois et concis.
- "puces" : EXACTEMENT une puce par article reçu, dans le même ordre. Chaque puce commence par une minuscule et nomme : les prestations attendues, la QUANTITÉ ET L'UNITÉ RECOPIÉES À L'IDENTIQUE (même nombre, mêmes chiffres), l'article, et la précision du demandeur reformulée proprement (sans guillemets superflus, avec les accents). Exemple : "la conception graphique, l'impression et la fourniture de 500 boîtes de lingettes désinfectantes personnalisées aux couleurs d'Adventum".
- Prestations, dans les mots d'une lettre : Conception → la conception graphique (création, maquette) ; Impression → l'impression ; Fabrication → la fabrication ; Achat → la fourniture ; Location → la location ; Livraison → la livraison ; Installation → l'installation et le montage ; Autre prestation → la prestation.
- N'INVENTE JAMAIS : ni quantité, ni format, ni matière, ni finition, ni couleur, ni délai, ni budget, ni prix, ni date, ni lieu, ni marque. Si une information manque, ne la suppose pas — demande-la dans "precisions" si elle est utile au chiffrage.
- Ne mentionne jamais : les références internes (CAT-…, MP-…, DEM-…), le circuit interne (validations, secrétariat, Direction), ni aucune allégation thérapeutique. Un produit promu se cite par son nom, sans plus.
- "introduction" : une ou deux phrases qui demandent l'offre (ex. "Dans le cadre de [contexte si fourni], nous vous remercions de bien vouloir nous adresser votre meilleure offre pour :").
- "precisions" : 3 à 6 éléments à faire figurer dans l'offre, adaptés aux articles — toujours le prix unitaire et le total hors taxes avec la TVA applicable, le délai de réalisation et de livraison, la validité de l'offre ; pour de l'imprimé ou du brandé : le bon à tirer (BAT) ou une maquette avant production ; pour des objets : un échantillon ou un visuel si possible ; pour une location ou un stand : les conditions de montage et démontage.
- "conclusion" : une phrase de disponibilité ; ne répète pas la formule de politesse (elle est ajoutée ensuite).
- "objet" : "Demande de devis — " suivi d'un intitulé court et clair.`;

const SCHEMA = {
  name: "lettre_demande_devis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["objet", "introduction", "puces", "precisions", "conclusion"],
    properties: {
      objet: { type: "string" },
      introduction: { type: "string" },
      puces: { type: "array", items: { type: "string" } },
      precisions: { type: "array", items: { type: "string" } },
      conclusion: { type: "string" },
    },
  },
};

export interface ContenuDemandeDevis {
  titre: string;
  brief: string | null;
  articles: ArticleADeviser[];
}

/** RÉDIGER — Luna d'abord, la lettre de secours si elle se tait, tarde ou se trompe. Ne lève jamais. */
export async function redigerLettreDevis(d: ContenuDemandeDevis): Promise<{ lettre: LettreDevis; parLuna: boolean }> {
  const secours = lettreDeSecours(d);
  if (d.articles.length === 0) return { lettre: secours, parLuna: false };
  const entree = {
    contexte: d.titre,
    brief: d.brief?.trim() || null,
    articles: d.articles.map((a) => ({
      article: a.designation, quantite: quantiteEnLettre(a), prestations: a.prestations,
      precision: a.precision?.trim() || null, produitsPromus: a.produits,
    })),
  };
  try {
    const r = await Promise.race([
      callLuna<unknown>({ system: SYSTEME, user: JSON.stringify(entree), jsonSchema: SCHEMA, maxOutputTokens: 2000, model: lunaModel() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_LUNA_MS)),
    ]);
    if (!r || !r.ok) return { lettre: secours, parLuna: false };
    let brut: unknown = r.data;
    if (brut === undefined) { try { brut = JSON.parse(r.text); } catch { brut = null; } }
    const lettre = lettreValide(brut, d.articles);
    return lettre ? { lettre, parLuna: true } : { lettre: secours, parLuna: false };
  } catch {
    return { lettre: secours, parLuna: false };
  }
}

const majuscule = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Les blocs Word de la lettre — date, référence, objet, corps, puces, précisions, politesse, signature. */
function blocsDeLaLettre(l: LettreDevis, m: { reference: string | null; signataire: string; societe: string | null; date: Date }): string[] {
  const date = m.date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return [
    paragraphe(`Le ${date}`, { alignement: "right", apresPt: 14 }),
    ...(m.reference ? [paragraphe([{ texte: "Réf. : ", gras: true }, { texte: m.reference }], { apresPt: 4 })] : []),
    paragraphe([{ texte: "Objet : ", gras: true }, { texte: l.objet, gras: true }], { apresPt: 16 }),
    paragraphe("Madame, Monsieur,", { apresPt: 10 }),
    paragraphe(l.introduction, { alignement: "both", apresPt: 6 }),
    ...l.puces.map((p) => paragraphe(`•   ${majuscule(p)}`, { alignement: "left", apresPt: 4 })),
    ...(l.precisions.length
      ? [
        paragraphe("Merci de bien vouloir préciser dans votre offre :", { avantPt: 8, apresPt: 4 }),
        ...l.precisions.map((p) => paragraphe(`•   ${majuscule(p)}`, { apresPt: 2 })),
      ]
      : []),
    paragraphe(l.conclusion, { alignement: "both", avantPt: 10, apresPt: 8 }),
    paragraphe("Nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.", { alignement: "both", apresPt: 28 }),
    paragraphe(m.signataire, { gras: true, alignement: "right" }),
    ...(m.societe ? [paragraphe(m.societe, { alignement: "right" })] : []),
  ];
}

const nomDeFichier = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);

export type DepotLettreDevis =
  | {
    ok: true; parLuna: boolean; texte: string; pdf: boolean; surPapierEnTete: boolean;
    /** La référence NNN/DG/AAAA attribuée au registre commun de la société ; `null` hors registre. */
    referenceRegistre: string | null;
  }
  | { ok: false; error: string };

/**
 * LA SOCIÉTÉ DONT LA LETTRE PORTE L'EN-TÊTE — et donc la référence : celle qu'on nomme, sinon celle du rédacteur (la même
 * résolution que `profilDocumentaire`, que le champ « Référence » du formulaire lit aussi pour préremplir le prochain numéro).
 */
export async function societeDeLaLettre(user: CurrentUser, societeId: string | null): Promise<string | null> {
  if (societeId) return societeId;
  const r = await resoudreSociete(user.id, null).catch(sansBloquer("demande-devis-depot.societeDeLaLettre.resoudreSociete", null));
  return r && r.ok ? r.societe.id : null;
}

/**
 * RÉDIGER, COMPOSER, DÉPOSER — sur chaque objet de `cibles` (le dossier ou le poste d'abord, puis la demande au secrétariat).
 * `societeId` : la société dont le papier en-tête habille la lettre (`null` : celle du rédacteur).
 *
 * LA RÉFÉRENCE (Direction, 10/2026 : « tout document généré doit avoir la numérotation NNN/DG/AAAA ») : quand la société tient
 * le registre commun, la lettre prend le prochain numéro de son registre — ou `referenceChoisie`, saisie au formulaire et
 * vérifiée (libre pour la société et l'année, tous documents confondus). Hors registre, `reference` (celle du dossier).
 */
export async function deposerLettreDevis(
  user: CurrentUser,
  cibles: { entityType: EntityType; entityId: string }[],
  d: ContenuDemandeDevis & { reference: string | null; societeId: string | null; referenceChoisie?: string | null },
): Promise<DepotLettreDevis> {
  if (cibles.length === 0) return { ok: false, error: "Aucun objet où déposer la demande de devis." };
  const profil = await profilDocumentaire(user, d.societeId).catch(sansBloquer("demande-devis-depot.deposerLettreDevis.profilDocumentaire", null));
  const societeId = profil && profil.ok ? profil.profil.societe.id : d.societeId;
  const annee = anneeDuRegistre();
  const registre = await registreDe(societeId, annee);
  const choisie = d.referenceChoisie?.trim() || null;
  // Un numéro choisi se vérifie AVANT la rédaction (Luna peut prendre vingt secondes) ; il est réattribué sous verrou ensuite.
  if (registre.actif && societeId && choisie) {
    const libre = await verifierReferenceLibre(societeId, choisie, annee);
    if (!libre.ok) return { ok: false, error: libre.motif };
  }
  const { lettre, parLuna } = await redigerLettreDevis(d);
  let reference = d.reference;
  let referenceRegistre: string | null = null;
  if (registre.actif && societeId) {
    const r = await attribuerAuRegistre({
      companyId: societeId, annee, docType: "DEMANDE_DEVIS", entityType: cibles[0].entityType, entityId: cibles[0].entityId,
      createdById: user.id, saisie: choisie,
    });
    if (!r.ok) return { ok: false, error: r.motif };
    reference = referenceRegistre = r.reference;
  }
  const habillage = profil && profil.ok ? profil.habillage : null;
  const composition = composerDocx({
    blocs: blocsDeLaLettre(lettre, {
      reference, signataire: user.name ?? "", societe: profil && profil.ok ? profil.profil.societe.nom : null, date: new Date(),
    }),
    base: habillage?.base ?? null,
    police: habillage?.police ?? undefined,
    logo: habillage?.logo ?? null,
    titre: lettre.objet,
    auteur: user.name ?? "Adventum",
  });
  const pdf = await docxToPdf(composition.octets).catch(sansBloquer("demande-devis-depot.deposerLettreDevis.docxToPdf", { ok: false as const, error: "conversion impossible" }));
  const base = nomDeFichier(`Demande de devis — ${reference ?? d.titre}`);
  const fichiers: { nom: string; octets: Buffer; mime: string }[] = [
    ...(pdf.ok ? [{ nom: `${base}.pdf`, octets: pdf.pdf, mime: "application/pdf" }] : []),
    { nom: `${base}.docx`, octets: composition.octets, mime: MIME_DOCX },
  ];
  for (const c of cibles) {
    for (const f of fichiers) {
      const cle = `${c.entityType}/${c.entityId}/${randomUUID()}__${f.nom}`;
      await saveFile(cle, f.octets);
      await prisma.document.create({
        data: {
          name: f.nom, category: "OTHER", entityType: c.entityType, entityId: c.entityId, stepKey: ETAPE_DEMANDE_DEVIS,
          fileKey: cle, mimeType: f.mime, sizeBytes: f.octets.length, confidentiality: "INTERNAL", uploadedById: user.id,
        },
      });
    }
  }
  return { ok: true, parLuna, texte: texteDeLaLettre(lettre), pdf: pdf.ok, surPapierEnTete: composition.surPapierEnTete, referenceRegistre };
}

/** La phrase de fin d'un dépôt — ce qui est parti, sous quelle forme, et sous quelle référence. */
export function phraseDepotLettre(r: Extract<DepotLettreDevis, { ok: true }>): string {
  return `Demande de devis${r.referenceRegistre ? ` N° ${r.referenceRegistre}` : ""} ${r.pdf ? "en PDF et Word" : "en Word (le PDF n'a pas pu être produit)"}${r.surPapierEnTete ? ", sur papier en-tête" : ""}${r.parLuna ? ", rédigée par Luna" : ""}.`;
}
