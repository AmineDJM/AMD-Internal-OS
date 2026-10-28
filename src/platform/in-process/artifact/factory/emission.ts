/**
 * Fabrique de documents — L'ÉMISSION : options, droit d'émettre, facture d'un avoir, jugement de la pièce
 * amont, registre de la pièce, et `emettreDocumentDrive` avec sa fin d'émission.
 */
import { Prisma, type EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { canEditCompanyId } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { portsArtefact } from "@/platform/in-process/artifact/ports";
import { construireDocumentCommercial } from "@/lib/artifact/factory/build";
import { empreinteDocument } from "@/lib/artifact/factory/empreinte";
import { formaterDzd, formaterNumero, LIBELLE_TYPE, NATURE_LEGALE, PREFIXE_DEFAUT, titreDocument, TYPES_DOCUMENT, verifierSpecCommerciale, departDe, type SpecDocumentCommercial, type TypeDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { attribuerReference, estMotifDg, largeurDuMotif, plancherRegistre, typeSurRegistre, validerReferenceSaisie } from "@/lib/references/registre";
import { magasinPrisma, rattacherReference } from "@/lib/references/registre-serveur";
import { nettoyerNumero, phraseNumeroPris, refusNumeroLibre, sequenceDuNumero } from "@/lib/bons-de-commande/numero-reference";
import { MIME_DOCX } from "@/lib/artifact/factory/word";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { montantsDesAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { refusPieceAmont, phrasePieceAmontNonRattachee, PIECE_AMONT_INTROUVABLE } from "@/lib/legal/piece-emise";
import { refusPlafondAvoir, resteACrediter } from "@/lib/lecteurs/avoir";
import type { PorteBC } from "@/lib/bons-de-commande/regle";
import { controlerRibDePiece } from "@/modules/coffre/api";
import { echec, type EchecFabrique, type Habillage, manquesDIdentite, profilDocumentaire, type ProfilDocumentaire } from "./profil";
import { attribuerNumero, type DemandeDocument, type DocumentEmis, echeanceLegale, type Fabrique, fabriqueDe, nomFichier, pdfDeLaPiece, reserveDuBC, reservePdf, resumeTotaux, specDepuisDemande } from "./demande";
import { motifDe, peutEcrire, porterSerieAuMoins, porteurDuNumero } from "./numerotation";

/**
 * CE QU'UN APPELANT DU SERVEUR — et lui seul — peut ajouter à une émission.
 *
 * Ces options ne vivent PAS dans `DemandeDocument` : la capacité d'Adam passe l'entrée du modèle
 * telle quelle comme demande (`office-capabilities.ts`), et un champ de la demande serait donc
 * écrivable par un document lu, par un mail, par une phrase. Un second argument, lui, n'existe que
 * pour le code qui l'écrit.
 *
 *  • `source` : l'objet métier qui a fait naître la pièce (`LegalDocument.sourceType/sourceId`).
 *    C'est lui qui aiguille le BC vers le centre de validation d'Ad & Pro, et lui qui fait
 *    compter la pièce dans les chantiers du dossier.
 *  • `delegation` : la RÈGLE MÉTIER qui autorise l'émission à la place du droit d'écrire dans
 *    Legal ou dans Finances — nommée, parce que l'audit la reprend. Le demandeur d'un matériel
 *    promotionnel validé n'a pas le module Legal, et c'est pourtant lui que la Direction charge
 *    de générer ses bons de commande (§118.152) : ce qui l'y autorise, ce sont les validations
 *    obtenues sur son dossier — vérifiées par l'appelant, et par lui seul.
 *
 * ── LA SOCIÉTÉ SOUS DÉLÉGATION, et pourquoi le droit d'« engager » y cède ─────────────────
 * Le droit d'ENGAGER une société (`canEditCompanyId`) est une autorisation NOMINATIVE que
 * l'administration pose sur une entité voisine ; l'appartenance à une société n'en donne AUCUN,
 * et seul le Super Admin l'a sur tout le groupe. Mesuré au banc (§118.152) : un demandeur de la
 * Direction Marketing et une assistante de direction, salariés de la société, ne pouvaient pas
 * générer le BC que la Direction avait validé — « Vous voyez la société sans pouvoir
 * l'engager », c'est-à-dire un « je ne peux pas » écrit dans le code, sur le geste que la
 * Direction leur confie (§118.63). Sous délégation, ce sont donc les validations du dossier qui
 * tiennent lieu de ce droit, et pour UNE société seulement :
 *  • celle que l'APPELANT nomme — la société du dossier, jamais un repli sur celle de la personne
 *    qui clique : sans société nommée, l'émission déléguée est refusée ;
 *  • parmi celles que la personne peut LIRE (`resoudreSociete`) : la délégation remplace le droit
 *    d'écrire, jamais celui de voir. Quelqu'un que le groupe tient hors d'une entité n'émet pas
 *    en son nom, quelle que soit la validation obtenue.
 * Ce que la pièce engage ensuite reste gardé plus loin : le centre de validation au-dessus du
 * seuil, puis la signature des Finances (§118.149) — c'est elle, et non l'émission, qui fait
 * d'un BC un engagement de la société.
 */
export interface OptionsEmission {
  source?: { type: EntityType; id: string } | null;
  delegation?: string | null;
  /**
   * QUI A DÉCLENCHÉ L'ÉMISSION (§118.153). `ADAM` : la capacité de conversation. Absent : une
   * PERSONNE a cliqué sur un écran (Finances, Legal, matériel promotionnel). La pièce et l'audit
   * écrivaient « émis par Adam » quel que soit le chemin — mesuré en parcours réel, sur un BC que
   * les Finances venaient de générer d'un clic, dans un ERP où Adam n'est visible que du Super
   * Admin : la note attribuait l'engagement à un acteur que la personne ne voit pas, et effaçait
   * celle qui l'avait pris. Le défaut est l'HUMAIN : c'est le seul canal qu'on ne peut pas oublier
   * de déclarer sans mentir.
   */
  canal?: "ADAM" | null;
}

const ARTICLE_TYPE: Record<TypeDocumentCommercial, string> = { DEVIS: "un devis", BON_DE_COMMANDE: "un bon de commande", FACTURE: "une facture", AVOIR: "un avoir" };

/** Le refus d'émettre sans le droit — les Finances tiennent la chaîne d'achat et de facturation, pas les devis. */
export const phraseDroitDEmettre = (type: TypeDocumentCommercial): string =>
  `Émettre ${ARTICLE_TYPE[type]} exige le droit de créer dans Legal${type !== "DEVIS" ? " ou dans Finances" : ""}.`;

/** Le préfixe de numérotation : celui du profil, et pour l'avoir — que le profil ne règle pas — celui par défaut. */
export const prefixeDe = (type: TypeDocumentCommercial, profil: ProfilDocumentaire): string =>
  type === "DEVIS" ? profil.reglages.quotePrefix
    : type === "BON_DE_COMMANDE" ? profil.reglages.orderPrefix
      : type === "AVOIR" ? PREFIXE_DEFAUT.AVOIR
        : profil.reglages.invoicePrefix;

/**
 * L'AVOIR ET SA FACTURE (§118.195). La facture d'origine se lit sur le LIEN, jamais sur la demande : le client,
 * le numéro et la date que l'avoir imprime sont ceux de la facture qu'il corrige. Une demande qui dirait autre
 * chose créditerait un autre client, ou « corrigerait » une facture qu'elle ne nomme pas.
 */
export async function factureDeLAvoir(user: CurrentUser, chainFromId: string | null | undefined, societeId: string): Promise<
  {
    ok: true; id: string; numero: string; ttc: number; tiers: SpecDocumentCommercial["tiers"]; date: string; numeroClient: string | null;
    /** Ce que l'avoir calcule COMME sa facture, sauf demande contraire : un crédit au même prix doit porter la même TVA, la même remise, les mêmes taxes. */
    calcul: Pick<SpecDocumentCommercial, "tvaDefaut" | "remiseGlobale" | "taxes">;
  }
  | EchecFabrique
> {
  const id = (chainFromId ?? "").trim();
  if (!id) return echec("MISSING_INPUT", "Un avoir corrige UNE facture : émettez-le depuis la fiche de la facture (« Émettre un avoir »).");
  const doc = await prisma.legalDocument.findUnique({ where: { id }, select: { id: true, companyId: true, kind: true, status: true, custom: true } });
  // LA FACTURE QU'ON CRÉDITE, ON LA LIT (lot D1c — F1) : un identifiant forgé désignait une facture restreinte à
  // d'autres lecteurs, et l'avoir en imprimait le client et le numéro. Illisible, elle se dit comme absente (§118.71).
  if (!doc || !(await canAccessEntity(user, "LEGAL_DOCUMENT", doc.id, "VIEW"))) return echec("NOT_FOUND", "La facture à créditer n'existe plus.");
  const f = fabriqueDe(doc.custom);
  if (doc.kind !== "INVOICE" || !f || f.type !== "FACTURE") {
    return echec("MISSING_INPUT", "Un avoir se rattache à une facture émise par la plateforme : cette pièce n'en est pas une — une facture déposée se corrige par la pièce que son émetteur envoie.");
  }
  if (doc.companyId && doc.companyId !== societeId) return echec("MISSING_INPUT", "La facture à créditer appartient à une autre société.");
  if (doc.status === "CANCELLED") return echec("CAPABILITY_FAILURE", `La facture ${f.numero} est annulée : il n'y a rien à créditer.`);
  return {
    ok: true, id: doc.id, numero: f.numero, ttc: f.totaux?.totalTtc ?? 0, tiers: f.spec.tiers, date: f.spec.date, numeroClient: f.spec.numeroClient ?? null,
    calcul: { tvaDefaut: f.spec.tvaDefaut ?? null, remiseGlobale: f.spec.remiseGlobale ?? null, taxes: f.spec.taxes ?? null },
  };
}

/**
 * LA PIÈCE DONT UNE ÉMISSION DÉCOULE (audit 360°, lot D1c — F1) — lue, et jugée, AVANT qu'un numéro existe. La
 * fabrique ne vérifiait que l'existence et la société : un BC pouvait suivre une facture, un devis annulé, ou — par
 * un identifiant forgé — un devis que la personne ne lit pas (§118.71). Lisible d'abord (sinon la phrase de
 * l'absence : rien n'est révélé de la pièce désignée), la société, puis la nature et le statut (`refusPieceAmont`,
 * la table que lit aussi le menu du compositeur). L'avoir a sa propre lecture (`factureDeLAvoir`).
 */
export async function jugerPieceAmont(user: CurrentUser, type: TypeDocumentCommercial, chainFromId: string, societeId: string): Promise<EchecFabrique | null> {
  const amont = await prisma.legalDocument.findUnique({
    where: { id: chainFromId }, select: { id: true, companyId: true, kind: true, status: true, reference: true, title: true },
  });
  if (!amont || !(await canAccessEntity(user, "LEGAL_DOCUMENT", amont.id, "VIEW"))) return echec("NOT_FOUND", PIECE_AMONT_INTROUVABLE);
  if (amont.companyId && amont.companyId !== societeId) return echec("MISSING_INPUT", "La pièce amont appartient à une autre société.");
  const refus = refusPieceAmont(type, { kind: String(amont.kind), status: String(amont.status), nom: amont.reference?.trim() || amont.title });
  return refus ? echec("MISSING_INPUT", refus) : null;
}

class PlafondAvoirDepasse extends Error {}

/** Un numéro choisi refusé SOUS VERROU (pris entre la vérification et l'écriture) : la transaction est annulée, le refus dit. */
export class ReferenceRefusee extends Error {}

/**
 * LA PIÈCE VA-T-ELLE AU REGISTRE COMMUN NNN/DG/AAAA (Direction, 10/2026) ? Le BC d'une société qui le tient, et toute nature
 * au motif /DG/ : son numéro vient du compteur COMMUN de la société (ordres de mission, demandes de devis… compris), pas de
 * la série de sa nature. `null` : la pièce garde sa série (`attribuerNumero`).
 */
export function registreDeLaPiece(type: TypeDocumentCommercial, profil: ProfilDocumentaire, annee: number): { plancher: number; largeur: number } | null {
  const motif = profil.reglages.numerotation[type] ?? null;
  if (!typeSurRegistre(type, motif, profil.reglages.registreDG === true)) return null;
  return {
    plancher: plancherRegistre({ numerotation: profil.reglages.numerotation, numerotationDepart: profil.reglages.numerotationDepart }, annee),
    largeur: estMotifDg(motif) ? largeurDuMotif(motif) : 3,
  };
}

/** « par Adam » ou « par <la personne> » — la même lecture pour la pièce, l'audit et la révision. */
export function parQui(user: CurrentUser, canal: OptionsEmission["canal"]): string {
  return canal === "ADAM" ? "par Adam" : `par ${user.name?.trim() || "un utilisateur"}`;
}

/**
 * ÉMET une pièce : vérifie, compose à blanc, reconnaît un doublon, numérote avec la pièce au
 * registre, écrit le fichier (et son PDF), termine la pièce.
 */
export async function emettreDocumentDrive(user: CurrentUser, demande: DemandeDocument, opts: OptionsEmission = {}): Promise<DocumentEmis | EchecFabrique> {
  const debut = Date.now();
  const type = demande.type;
  if (!TYPES_DOCUMENT.includes(type)) return echec("MISSING_INPUT", `Type de document inconnu : « ${String(type)} » (${TYPES_DOCUMENT.join(", ")}).`);
  if (!opts.delegation && !peutEcrire(user, "CREATE", type)) {
    return echec("MISSING_PERMISSION", phraseDroitDEmettre(type));
  }
  // Sous délégation, la société est celle que l'APPELANT nomme (celle du dossier) : pas de repli
  // sur la société de la personne qui clique — la délégation vaut pour UNE société, pas pour toutes.
  if (opts.delegation && !(demande.societe ?? "").trim()) {
    return echec("MISSING_INPUT", "Cette émission est autorisée par un dossier qui ne nomme aucune société : rattachez le dossier à la société qui commande, puis relancez.");
  }
  const p = await profilDocumentaire(user, demande.societe, { papierEnTeteId: demande.letterheadId ?? null, type });
  if (!p.ok) return p;
  const { profil, papierOctets, habillage } = p;
  if (!opts.delegation && !(await canEditCompanyId(user.id, profil.societe.id))) return echec("MISSING_PERMISSION", `Vous voyez ${profil.societe.nom} sans pouvoir l'engager : la pièce ne peut pas être émise en son nom.`);

  // L'AVOIR SE LIT SUR SA FACTURE (§118.195) : client, numéro et date d'origine viennent du lien, pas de la demande.
  let facture: { id: string; numero: string; ttc: number } | null = null;
  if (type === "AVOIR") {
    const lu = await factureDeLAvoir(user, demande.chainFromId, profil.societe.id);
    if (!lu.ok) return lu;
    facture = { id: lu.id, numero: lu.numero, ttc: lu.ttc };
    demande = {
      ...demande, tiers: lu.tiers, referenceAmont: lu.numero, referenceAmontDate: lu.date, numeroClient: lu.numeroClient, chainFromId: lu.id,
      tvaDefaut: demande.tvaDefaut ?? lu.calcul.tvaDefaut, remiseGlobale: demande.remiseGlobale ?? lu.calcul.remiseGlobale, taxes: demande.taxes ?? lu.calcul.taxes,
    };
  }

  // LE COFFRE (refonte V2-E) : le RIB du tiers (fiche de l'annuaire ou recopié du devis) passe la politique au goulot.
  const tiersRib = await controlerRibDePiece(user, demande.tiers?.rib, `${demande.type} pour ${demande.tiers?.nom ?? "?"} — RIB du tiers`);
  const base = specDepuisDemande(demande.tiers ? { ...demande, tiers: { ...demande.tiers, rib: tiersRib } } : demande, profil);
  const provisoire: SpecDocumentCommercial = { ...base, numero: "PROVISOIRE" };
  const regles = verifierSpecCommerciale(provisoire);
  if (regles.bloquants.length > 0) {
    return echec("MISSING_INPUT", `${LIBELLE_TYPE[type]} non émis${type === "FACTURE" ? "e" : ""} : ${regles.bloquants.slice(0, 4).join(" ; ")}`, { bloquants: regles.bloquants });
  }
  // Un `chainFromId` VIDE n'est pas un chaînage : le modèle envoie volontiers "" pour « aucune
  // pièce amont », et une chaîne vide passait le test de présence puis violait la clé étrangère
  // au moment d'écrire — mesuré au banc des défis : « erreur technique », aucun devis émis.
  const chainFromId = (demande.chainFromId ?? "").trim() || null;
  demande = { ...demande, chainFromId };
  if (chainFromId && type !== "AVOIR") {
    const refusAmont = await jugerPieceAmont(user, type, chainFromId, profil.societe.id);
    if (refusAmont) return refusAmont;
  }
  // LA RÉPÉTITION À BLANC : tout ce qui peut bloquer bloque ICI, avant qu'un numéro existe.
  const essai = await construireDocumentCommercial(provisoire, habillage);
  if (!essai.verification.ok || !essai.totaux) {
    return echec("CAPABILITY_FAILURE", `${LIBELLE_TYPE[type]} non émis${type === "FACTURE" ? "e" : ""} : ${essai.verification.bloquants.slice(0, 4).join(" ; ")}`, { bloquants: essai.verification.bloquants });
  }
  // ── LE DOUBLON, ET L'ÉMISSION INTERROMPUE ────────────────────────────────────────────
  const empreinte = empreinteDocument(base, profil.societe.id);
  const kind = NATURE_LEGALE[type];
  if (!demande.forcerDoublon) {
    const existant = await prisma.legalDocument.findFirst({
      where: { companyId: profil.societe.id, kind, status: { not: "CANCELLED" }, custom: { path: ["fabrique", "empreinte"], equals: empreinte } },
      select: { id: true, reference: true, custom: true, driveNodeId: true, chainFromId: true },
      orderBy: { createdAt: "asc" },
    });
    const f = existant ? fabriqueDe(existant.custom) : null;
    if (existant && f) {
      // L'empreinte du doublon ne porte pas la chaîne : la pièce identique rendue peut ne pas suivre la pièce amont
      // demandée — on le DIT, avec le geste qui la rattache, au lieu de rendre une pièce non chaînée sans un mot.
      const avertissementAmont = phrasePieceAmontNonRattachee(f.numero, existant.chainFromId, demande.chainFromId ?? null);
      if (f.etat === "EMIS" && f.docx && existant.driveNodeId) {
        // RÉÉMETTRE UN BC, C'EST AUSSI LE RÉAIGUILLER — idempotent : une porte présente n'est pas
        // reposée, une porte ABSENTE l'est. C'est ce qui rattrape, à la reprise d'une mission, le
        // BC dont l'aiguillage avait échoué la première fois : sans cette ligne, la reprise
        // rendait « pièce identique déjà émise » et le BC restait hors de tout centre (§118.148).
        const aiguillage = type === "BON_DE_COMMANDE" ? await aiguillerBC(existant.id, { acteurId: user.id }) : null;
        const porteExistante = aiguillage?.porte ?? null;
        const reserveExistante = aiguillage ? reserveDuBC(aiguillage) : null;
        return {
          ok: true, dejaEmis: true, repris: false, legalDocumentId: existant.id, reference: f.numero, type, version: f.version,
          societe: { id: profil.societe.id, nom: profil.societe.nom }, tiers: base.tiers.nom,
          docx: { nodeId: f.docx.nodeId, nom: nomFichier(f.numero, base.tiers.nom, "docx"), version: f.docx.version },
          pdf: f.pdf ? { nodeId: f.pdf.nodeId, nom: nomFichier(f.numero, base.tiers.nom, "pdf"), pages: f.pdf.pages, methode: f.pdf.methode ?? "rendu" } : null,
          totaux: f.totaux, surPapierEnTete: f.surPapierEnTete,
          avertissements: [
            `Une pièce identique existait déjà (${f.numero}) : elle est rendue, aucune nouvelle pièce n'a été émise.`,
            ...(avertissementAmont ? [avertissementAmont] : []),
            ...(reserveExistante ? [reserveExistante] : []),
          ],
          reglesAppliquees: profil.reglesAppliquees, porteBC: porteExistante, reserveBonDeCommande: reserveExistante, ms: Date.now() - debut,
        };
      }
      return terminerEmission(user, existant.id, { ...f, spec: { ...base, numero: f.numero } }, habillage, demande, profil, { repris: true, debut, avertissements: [...essai.verification.avertissements, ...(avertissementAmont ? [avertissementAmont] : [])], delegation: opts.delegation ?? null, canal: opts.canal ?? null });
    }
  }

  // CE QUI RESTE À CRÉDITER, dit avant qu'un numéro existe — et revérifié sous verrou au moment d'écrire. APRÈS le
  // doublon, jamais avant : l'avoir identique déjà inscrit compte parmi les avoirs actifs, et le juger contre ce qui
  // reste refusait « entièrement créditée » la resoumission d'un avoir TOTAL au lieu de rendre la pièce — et empêchait
  // pour toujours de reprendre une émission interrompue, dont la ligne restait comptée sans fichier (§118.195).
  if (facture) {
    const refus = refusPlafondAvoir(facture.numero, essai.totaux.totalTtc, resteACrediter(facture.ttc, await montantsDesAvoirsActifs(facture.id)));
    if (refus) return echec("MISSING_INPUT", refus);
  }

  // ── LE NUMÉRO ET LA PIÈCE, ENSEMBLE ──────────────────────────────────────────────────
  const annee = Number(base.date.slice(0, 4));
  const prefixe = prefixeDe(type, profil);
  const totaux = essai.totaux;
  // LE REGISTRE COMMUN NNN/DG/AAAA (Direction, 10/2026) : la pièce y prend son numéro — le prochain, ou celui CHOISI à la
  // génération (vérifié ici sur sa forme, puis sous verrou sur son unicité, tous types de documents de la société confondus).
  const registre = Number.isFinite(annee) ? registreDeLaPiece(type, profil, annee) : null;
  const saisie = demande.numeroChoisi?.trim() || null;
  // HORS REGISTRE, LE NUMÉRO D'UN BON DE COMMANDE SE CHOISIT AUSSI (Direction, 14/10/2026 — « il peut être écrit
  // manuellement ») : unique parmi les BC de la société, il porte le compteur de la série AU MOINS à sa séquence (jamais en
  // arrière). Une facture, un avoir, un devis gardent la série continue : leur numéro ne se choisit pas.
  if (saisie && !registre && type !== "BON_DE_COMMANDE") {
    return echec("MISSING_INPUT", `${profil.societe.nom} ne tient pas le registre NNN/DG/AAAA pour cette pièce (${LIBELLE_TYPE[type].toLowerCase()}) : son numéro vient de sa série et ne se choisit pas. Laissez le champ vide.`);
  }
  if (saisie && !registre) {
    const refus = refusNumeroLibre(saisie);
    if (refus) return echec("MISSING_INPUT", refus);
  }
  if (saisie && registre) {
    const v = validerReferenceSaisie(saisie, annee, registre.largeur);
    if (!v.ok) return echec("MISSING_INPUT", v.motif);
  }
  let cree: { id: string; fabrique: Fabrique };
  try {
  cree = await prisma.$transaction(async (tx) => {
    // DEUX AVOIRS SUR LA MÊME FACTURE ne lisent pas le même reste (§118.195) : la facture est verrouillée le temps de
    // compter ses avoirs et d'écrire celui-ci — entre deux processus aussi.
    if (facture) {
      await tx.$queryRaw`SELECT 1 FROM "LegalDocument" WHERE id = ${facture.id} FOR UPDATE`;
      const refus = refusPlafondAvoir(facture.numero, totaux.totalTtc, resteACrediter(facture.ttc, await montantsDesAvoirsActifs(facture.id, tx)));
      if (refus) throw new PlafondAvoirDepasse(refus);
    }
    let numero: string;
    let entreeRegistre: string | null = null;
    if (registre) {
      const r = await attribuerReference(magasinPrisma(tx), {
        companyId: profil.societe.id, annee, plancher: registre.plancher, largeur: registre.largeur,
        docType: type, entityType: "LEGAL_DOCUMENT", entityId: null, createdById: user.id, saisie,
      });
      if (!r.ok) throw new ReferenceRefusee(r.motif);
      numero = r.reference;
      entreeRegistre = r.id;
    } else if (saisie) {
      // LE NUMÉRO ÉCRIT À LA MAIN, hors registre : la série est verrouillée et portée au moins à sa séquence, puis il est
      // vérifié libre parmi les pièces de même nature de la société — sous ce verrou, deux saisies du même numéro s'attendent.
      numero = nettoyerNumero(saisie);
      await porterSerieAuMoins(tx, profil.societe.id, kind, annee, sequenceDuNumero(numero, { prefixe, annee, motif: motifDe(type, profil) }));
      const pris = await porteurDuNumero(tx, { companyId: profil.societe.id, kind, numero, registre: null, exclure: null });
      if (pris) throw new ReferenceRefusee(phraseNumeroPris(numero, pris));
    } else {
      const seq = await attribuerNumero(tx, profil.societe.id, kind, annee, departDe(profil.reglages.numerotationDepart, type, annee));
      numero = formaterNumero(prefixe, annee, seq, profil.reglages.numerotation[type] ?? null);
    }
    const fabrique: Fabrique = {
      version: 1, etat: "EN_COURS", type, empreinte, societeId: profil.societe.id, numero,
      spec: { ...base, numero }, totaux: resumeTotaux(totaux), docx: null, pdf: null,
      surPapierEnTete: essai.surPapierEnTete, papierEnTeteId: profil.papierEnTete?.id ?? null,
      emisPar: user.id, emisLe: new Date().toISOString(), historique: [],
    };
    const doc = await tx.legalDocument.create({
      data: {
        companyId: profil.societe.id, kind, reference: numero,
        title: titreDocument({ type, numero, tiers: base.tiers }),
        counterparty: base.tiers.nom,
        startDate: new Date(`${base.date}T00:00:00Z`),
        endDate: echeanceLegale(base),
        amount: new Prisma.Decimal(totaux.totalTtc),
        direction: type === "FACTURE" ? "IN" : null,
        chainFromId: demande.chainFromId ?? null,
        sourceType: opts.source?.type ?? null,
        sourceId: opts.source?.id ?? null,
        notes: `${LIBELLE_TYPE[type]} émis${type === "FACTURE" ? "e" : ""} ${parQui(user, opts.canal)} — TTC ${formaterDzd(totaux.totalTtc)}.`,
        createdById: user.id, updatedById: user.id,
        ...(demande.prevalidation && type === "BON_DE_COMMANDE" ? { bcPrevalidationAt: new Date() } : {}),
        custom: { fabrique } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    if (entreeRegistre) await rattacherReference(entreeRegistre, "LEGAL_DOCUMENT", doc.id, tx);
    return { id: doc.id, fabrique };
  });
  } catch (e) {
    if (e instanceof PlafondAvoirDepasse || e instanceof ReferenceRefusee) return echec("MISSING_INPUT", e.message);
    throw e;
  }
  return terminerEmission(user, cree.id, cree.fabrique, habillage, demande, profil, { repris: false, debut, avertissements: essai.verification.avertissements, delegation: opts.delegation ?? null, canal: opts.canal ?? null });
}

/** Compose la pièce numérotée, l'écrit dans le Drive (+ PDF), et clôt l'émission au registre. */
async function terminerEmission(
  user: CurrentUser, legalDocumentId: string, fabrique: Fabrique, habillage: Habillage, demande: DemandeDocument, profil: ProfilDocumentaire,
  ctx: { repris: boolean; debut: number; avertissements: string[]; delegation?: string | null; canal?: OptionsEmission["canal"] },
): Promise<DocumentEmis | EchecFabrique> {
  const spec = fabrique.spec;
  const construit = await construireDocumentCommercial(spec, habillage);
  if (!construit.verification.ok || !construit.totaux) {
    return echec("CAPABILITY_FAILURE", `La pièce ${fabrique.numero} est numérotée au registre mais son fichier n'a pas pu être composé : ${construit.verification.bloquants.slice(0, 3).join(" ; ")}`, { bloquants: construit.verification.bloquants });
  }
  const dossier = demande.dossier?.trim() || undefined;
  const nomDocx = nomFichier(fabrique.numero, spec.tiers.nom, "docx");
  const docx = await portsArtefact.documents.creerFichier(user.id, { nom: nomDocx, octets: construit.octets, mime: MIME_DOCX, dossier });
  let pdf: Fabrique["pdf"] = null;
  const avertissements = [...ctx.avertissements, ...manquesDIdentite(profil)];
  if (!demande.sansPdf) {
    const conv = await pdfDeLaPiece(user, { nodeId: docx.nodeId, version: docx.version }, construit.octets);
    if (conv.ok) {
      const noeud = await portsArtefact.documents.creerFichier(user.id, { nom: nomFichier(fabrique.numero, spec.tiers.nom, "pdf"), octets: conv.pdf, mime: "application/pdf", dossier });
      pdf = { nodeId: noeud.nodeId, version: noeud.version, pages: conv.pages, methode: conv.methode };
      const reserve = reservePdf(conv.methode, construit.surPapierEnTete);
      if (reserve) avertissements.push(reserve);
    } else avertissements.push(`PDF non produit : ${conv.error}`);
  }
  const finale: Fabrique = { ...fabrique, etat: "EMIS", docx: { nodeId: docx.nodeId, version: docx.version }, pdf, totaux: resumeTotaux(construit.totaux), surPapierEnTete: construit.surPapierEnTete };
  await prisma.legalDocument.update({
    where: { id: legalDocumentId },
    data: { driveNodeId: docx.nodeId, amount: new Prisma.Decimal(construit.totaux.totalTtc), updatedById: user.id, custom: { fabrique: finale } as unknown as Prisma.InputJsonValue },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: legalDocumentId,
    summary: `${LIBELLE_TYPE[spec.type]} ${fabrique.numero} émis${spec.type === "FACTURE" ? "e" : ""} ${parQui(user, ctx.canal)} pour ${spec.tiers.nom} — ${formaterDzd(construit.totaux.totalTtc)}${ctx.repris ? " (émission interrompue terminée)" : ""}${ctx.delegation ? ` — autorisé par : ${ctx.delegation}` : ""}`,
  });
  // TOUT BON DE COMMANDE PASSE PAR UN CENTRE DE VALIDATION (§118.148). La porte est posée APRÈS
  // la composition : le centre doit pouvoir OUVRIR la pièce qu'il valide, et elle n'existe
  // qu'une fois le fichier écrit. La réserve entre dans les avertissements, que la phrase reprend.
  let porteBC: PorteBC | null = null;
  let reserveBonDeCommande: string | null = null;
  if (spec.type === "BON_DE_COMMANDE") {
    const a = await aiguillerBC(legalDocumentId, { acteurId: user.id });
    porteBC = a.porte;
    reserveBonDeCommande = reserveDuBC(a);
    if (reserveBonDeCommande) avertissements.push(reserveBonDeCommande);
  }
  return {
    ok: true, dejaEmis: false, repris: ctx.repris, legalDocumentId, reference: fabrique.numero, type: spec.type, version: finale.version,
    societe: { id: profil.societe.id, nom: profil.societe.nom }, tiers: spec.tiers.nom,
    docx: { nodeId: docx.nodeId, nom: nomDocx, version: docx.version },
    pdf: pdf ? { nodeId: pdf.nodeId, nom: nomFichier(fabrique.numero, spec.tiers.nom, "pdf"), pages: pdf.pages, methode: pdf.methode ?? "rendu" } : null,
    totaux: finale.totaux, surPapierEnTete: construit.surPapierEnTete, avertissements, reglesAppliquees: profil.reglesAppliquees, porteBC, reserveBonDeCommande, ms: Date.now() - ctx.debut,
  };
}
