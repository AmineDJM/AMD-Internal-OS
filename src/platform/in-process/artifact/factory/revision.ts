/**
 * Fabrique de documents — LA RÉVISION : modifications contrôlées, spécification révisée, profil de la
 * révision, `reviserDocumentDrive`, aperçu d'une pièce pour l'écran et aperçu d'une révision.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canEditCompanyId } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { convertConfigured } from "@/lib/office-convert";
import { portsArtefact } from "@/platform/in-process/artifact/ports";
import { construireDocumentCommercial } from "@/lib/artifact/factory/build";
import { formaterDzd, LIBELLE_TYPE, titreDocument, verifierSpecCommerciale, type SpecDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { phraseNumeroPris, resumeChangementNumero } from "@/lib/bons-de-commande/numero-reference";
import { MENTION_NUMERO_SEUL, phraseNumeroSeul } from "@/lib/bons-de-commande/numero-seul";
import { MIME_DOCX } from "@/lib/artifact/factory/word";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { enSerie } from "@/lib/refs";
import { avalActif } from "@/lib/legal/aval";
import { refusRevisionAval } from "@/lib/legal/piece-emise";
import type { PorteBC } from "@/lib/bons-de-commande/regle";
import { controlerRibDePiece } from "@/modules/coffre/api";
import { sansBloquer } from "@/lib/journal";
import { echec, type EchecFabrique, manquesDIdentite, profilDocumentaire, type ProfilDocumentaire } from "./profil";
import { coordonneesChoisies, coordonneesParDefaut, type DemandeDocument, type DocumentEmis, echeanceLegale, emetteurDeLaPiece, type Fabrique, fabriqueDe, mentionsNettoyees, nomFichier, pdfDeLaPiece, piedDePageDe, reserveDuBC, reservePdf, resumeTotaux, signataireChoisi } from "./demande";
import { appliquerNumeroRevise, jugerNumeroRevise, peutEcrire, porteurDuNumero, revisionDeNumeroSeul } from "./numerotation";
import { type OptionsEmission, parQui, ReferenceRefusee } from "./emission";
import type { ApercuDocument } from "./apercu";

// ─────────────────────────── La révision ───────────────────────────

/**
 * CE QU'UNE RÉVISION PEUT CHANGER — TOUT ce que le composeur saisit (Direction, 10/2026 : « modifiables totalement, de A à
 * Z ») : le tiers et ses coordonnées, les lignes, la date (dans l'année de son numéro), les références, le paiement, la
 * TVA, la remise, les taxes, la livraison, le contact, les notes, le papier en-tête et les coordonnées imprimées de
 * l'émetteur. Restent la NATURE et la SOCIÉTÉ ; le NUMÉRO se change aussi (14/10/2026), unique dans sa série et tracé.
 */
export type ModificationsDocument = Partial<Pick<DemandeDocument, "tiers" | "lignes" | "date" | "echeance" | "validiteJours" | "tvaDefaut" | "remiseGlobale" | "modePaiement" | "conditionsPaiement" | "objet" | "referenceAmont" | "referenceAmontDate" | "numeroClient" | "contact" | "taxes" | "livraison" | "notes" | "coordonneesEmetteur" | "letterheadId" | "signataire" | "mentions">> & {
  /**
   * LE NUMÉRO DE RÉFÉRENCE, MODIFIÉ (Direction, 14/10/2026) — d'un BC ou d'un devis : unique dans sa série (registre commun
   * NNN/DG/AAAA, ou pièces de même nature de la société), le compteur porté au moins à lui, le changement tracé. Absent ou
   * identique : la pièce garde son numéro.
   */
  numero?: string | null;
};

/**
 * LA DATE D'UNE PIÈCE RÉVISÉE reste dans l'année de son numéro : « 012/DG/2026 » daté de 2027 serait une pièce que le
 * registre de 2027 ne connaît pas. `null` = acceptée.
 */
function refusDateRevisee(f: Fabrique, date: string | null | undefined): string | null {
  const d = (date ?? "").trim();
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return `La date « ${d} » ne se lit pas (AAAA-MM-JJ attendu).`;
  if (d.slice(0, 4) !== f.spec.date.slice(0, 4)) return `La pièce ${f.numero} est numérotée en ${f.spec.date.slice(0, 4)} : sa date révisée reste dans cette année. Pour une autre année, annulez-la et composez-en une nouvelle.`;
  return null;
}

/**
 * LA SPÉCIFICATION RÉVISÉE — une seule composition pour la révision et son aperçu : l'écran montre ce qui sera écrit.
 * CE QUI N'EST PAS NOMMÉ GARDE SA VALEUR, champ par champ (§118.152) ; `null` l'efface.
 */
/** LE COFFRE (refonte V2-E) : un RIB de tiers modifié à la révision passe la même politique qu'à l'émission. */
async function modificationsControlees(user: CurrentUser, m: ModificationsDocument, type: string): Promise<ModificationsDocument> {
  if (!m.tiers?.rib) return m;
  return { ...m, tiers: { ...m.tiers, rib: await controlerRibDePiece(user, m.tiers.rib, `${type} révisé — RIB du tiers`) } };
}

export function specRevisee(f: Fabrique, m: ModificationsDocument, p: ProfilDocumentaire): SpecDocumentCommercial {
  // LES COORDONNÉES DE L'ÉMETTEUR : celles choisies maintenant, sinon celles choisies à l'émission, sinon la carte
  // ACTUELLE de la société (une société qui a changé d'e-mail le voit sur la version suivante).
  const coordonnees = m.coordonneesEmetteur !== undefined ? coordonneesChoisies(m.coordonneesEmetteur) : coordonneesChoisies(f.spec.coordonneesEmetteur);
  const mentionsPiece = m.mentions !== undefined ? mentionsNettoyees(m.mentions) : mentionsNettoyees(f.spec.mentionsPiece);
  const sansCoordonnees: SpecDocumentCommercial = { ...f.spec };
  delete sansCoordonnees.coordonneesEmetteur;
  delete sansCoordonnees.mentionsPiece;
  return {
    ...sansCoordonnees,
    ...(coordonnees ? { coordonneesEmetteur: coordonnees } : {}),
    ...(mentionsPiece ? { mentionsPiece } : {}),
    emetteur: emetteurDeLaPiece(p, coordonnees),
    // LE PIED SUIT LES COORDONNÉES : un e-mail retiré de la pièce ne survit pas dans son pied.
    piedDePage: piedDePageDe(p, coordonnees, mentionsPiece),
    signataire: m.signataire !== undefined ? signataireChoisi(m.signataire) : f.spec.signataire,
    // LA CHARTE D'AUJOURD'HUI : une pièce révisée prend l'accent courant de la société (marque, sinon le bleu canard de la
    // maison) — l'ancien rouge d'une pièce émise avant la décision de la Direction ne survit pas à sa révision. Les pièces
    // NON révisées gardent leur couleur d'émission : un document émis ne se repeint pas.
    couleur: p.societe.couleur,
    date: m.date !== undefined && (m.date ?? "").trim() ? (m.date as string).trim() : f.spec.date,
    tiers: m.tiers ? { ...f.spec.tiers, ...m.tiers, nom: (m.tiers.nom ?? f.spec.tiers.nom).trim() } : f.spec.tiers,
    lignes: m.lignes ? m.lignes.map((l) => ({ ...l, designation: String(l.designation ?? "").trim(), ...(l.section ? { section: true, quantite: 0, prixUnitaire: 0 } : {}) })) : f.spec.lignes,
    echeance: m.echeance !== undefined ? m.echeance : f.spec.echeance,
    validiteJours: m.validiteJours !== undefined ? m.validiteJours : f.spec.validiteJours,
    tvaDefaut: m.tvaDefaut !== undefined ? m.tvaDefaut : f.spec.tvaDefaut,
    remiseGlobale: m.remiseGlobale !== undefined ? m.remiseGlobale : f.spec.remiseGlobale,
    modePaiement: m.modePaiement !== undefined ? m.modePaiement : f.spec.modePaiement,
    conditionsPaiement: m.conditionsPaiement !== undefined ? m.conditionsPaiement : f.spec.conditionsPaiement,
    objet: m.objet !== undefined ? m.objet : f.spec.objet,
    referenceAmont: m.referenceAmont !== undefined ? m.referenceAmont : f.spec.referenceAmont,
    referenceAmontDate: m.referenceAmontDate !== undefined ? m.referenceAmontDate : f.spec.referenceAmontDate,
    numeroClient: m.numeroClient !== undefined ? m.numeroClient : f.spec.numeroClient,
    // Remplacer l'objet entier effaçait l'adresse de livraison de qui ne changeait que le délai — et la pièce révisée
    // partait sans elle, sans un mot. Une clé ABSENTE garde sa valeur ; `null` l'efface.
    contact: m.contact !== undefined ? (m.contact === null ? null : { ...(f.spec.contact ?? {}), ...m.contact }) : f.spec.contact,
    taxes: m.taxes !== undefined ? m.taxes : f.spec.taxes,
    livraison: m.livraison !== undefined ? (m.livraison === null ? null : { ...(f.spec.livraison ?? {}), ...m.livraison }) : f.spec.livraison,
    notes: m.notes !== undefined ? m.notes : f.spec.notes,
  };
}

type ProfilCharge = Extract<Awaited<ReturnType<typeof profilDocumentaire>>, { ok: true }>;

/**
 * LE PAPIER D'UNE PIÈCE RÉVISÉE : celui choisi maintenant (vide = celui du profil), sinon celui de son émission — une
 * révision ne change pas de papier en silence. Le papier d'origine retiré depuis : celui du profil, et on le dit.
 */
export async function profilDeLaRevision(user: CurrentUser, companyId: string | null, f: Fabrique, m: ModificationsDocument): Promise<
  { ok: true; p: ProfilCharge; avertissement: string | null } | EchecFabrique
> {
  if (m.letterheadId !== undefined) {
    const p = await profilDocumentaire(user, companyId, { papierEnTeteId: (m.letterheadId ?? "").trim() || null });
    return p.ok ? { ok: true, p, avertissement: null } : p;
  }
  if (f.papierEnTeteId) {
    const p = await profilDocumentaire(user, companyId, { papierEnTeteId: f.papierEnTeteId });
    if (p.ok) return { ok: true, p, avertissement: null };
    if (p.echec !== "NOT_FOUND") return p;
  }
  const p = await profilDocumentaire(user, companyId);
  if (!p.ok) return p;
  return { ok: true, p, avertissement: f.papierEnTeteId && f.papierEnTeteId !== p.profil.papierEnTete?.id ? "Le papier en-tête de l'émission n'est plus actif : la version révisée prend celui du profil de la société." : null };
}

/**
 * RÉVISE un devis ou un bon de commande émis : même numéro, nouvelle version du même fichier,
 * historique au registre. Une FACTURE émise ne se réécrit pas — elle s'annule et une nouvelle se
 * compose, et la règle est dite.
 *
 * ── UNE RÉVISION À LA FOIS, SUR LA VERSION QU'ON A LUE (§118.194) ─────────────────────────────
 *
 * Deux révisions de la même pièce partaient chacune de la version N, écrivaient chacune une
 * « version N+1 » dans le Drive et au registre, et la seconde effaçait la première en silence —
 * l'historique portait deux fois le même numéro de version. La file (`enSerie`) les fait passer une
 * par une dans le processus ; `versionVue` — la version que l'écran a montrée — refuse celle qui
 * part d'une version dépassée, au lieu de réécrire par-dessus ce qu'un autre vient de corriger ; et
 * l'écriture au registre exige encore la version lue, pour le cas de deux processus.
 *
 * Une pièce dont découle une pièce ACTIVE (la facture d'un BC, le BC d'un devis) ne se révise plus :
 * la règle vit ICI, chez l'écrivain, pour tous ses appelants (§118.106).
 */
export async function reviserDocumentDrive(
  user: CurrentUser,
  opts: { legalDocumentId: string; modifications: ModificationsDocument; motif?: string | null; versionVue?: number | null; exigerMotif?: boolean },
  emission: Pick<OptionsEmission, "delegation" | "canal"> = {},
): Promise<DocumentEmis | EchecFabrique> {
  // LA FILE enveloppe le corps ENTIER, et le corps reste ICI : la dérivation des contrats ne suit qu'un niveau
  // de délégation (§118.87c) — déporté dans une fonction voisine, il ne déclarait plus ses écritures.
  return enSerie(`fabrique:revision:${opts.legalDocumentId}`, async () => {
    const debut = Date.now();
    const doc = await prisma.legalDocument.findUnique({ where: { id: opts.legalDocumentId }, select: { id: true, companyId: true, kind: true, status: true, custom: true, driveNodeId: true, signedAt: true } });
    const f = doc ? fabriqueDe(doc.custom) : null;
    if (!doc || !f) return echec("NOT_FOUND", "Cette pièce n'existe pas, ou n'a pas été émise par la fabrique (seules celles-ci se révisent).");
    if (f.type === "FACTURE") return echec("CAPABILITY_FAILURE", `La facture ${f.numero} est émise : une facture ne se réécrit pas. Pour la corriger, émettez un avoir depuis sa fiche — en totalité ou en partie.`);
    if (f.type === "AVOIR") return echec("CAPABILITY_FAILURE", `L'avoir ${f.numero} est émis : un avoir ne se réécrit pas. Pour le corriger, annulez-le (motif à l'appui) et émettez-en un autre depuis la facture.`);
    if (doc.status !== "ACTIVE") return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} est ${doc.status === "CANCELLED" ? "annulée" : "close"} : elle ne se révise plus.`);
    if (!emission.delegation && !peutEcrire(user, "UPDATE", f.type)) return echec("MISSING_PERMISSION", "Réviser cette pièce exige le droit de modifier dans Legal.");
    // Sous délégation, le droit d'engager cède aux validations du dossier (voir `OptionsEmission`) ;
    // le droit de VOIR la société reste exigé plus bas, par `profilDocumentaire`.
    if (!emission.delegation && !(await canEditCompanyId(user.id, doc.companyId))) return echec("MISSING_PERMISSION", "Cette pièce appartient à une société que vous ne pouvez pas engager.");
    if (!doc.driveNodeId || !f.docx) return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} n'a pas de fichier : relancer son émission avant de la réviser.`);
    // CE QUI EN DÉCOULE la retient (§118.194) : la facture d'un BC, le BC d'un devis.
    const aval = await avalActif(doc.id, f.type);
    if (aval) return echec("CAPABILITY_FAILURE", refusRevisionAval(f.type, aval));
    // LA VERSION QU'ON A LUE : partie d'une version dépassée, la révision réécrirait ce qu'un autre vient de corriger.
    if (opts.versionVue != null && opts.versionVue !== f.version) {
      return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} a été révisée entre-temps (version ${f.version}) : rouvrez-la pour partir de sa version actuelle.`);
    }
    // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18) : demandé après tout ce qui refuserait la révision.
    if (opts.exigerMotif && !opts.motif?.trim()) {
      return echec("MISSING_INPUT", "Dites ce qui change dans cette pièce : c'est ce que retiendra son historique.");
    }
    const m = await modificationsControlees(user, opts.modifications ?? {}, f.type);
    const refusDate = refusDateRevisee(f, m.date);
    if (refusDate) return echec("MISSING_INPUT", refusDate);
    const lu = await profilDeLaRevision(user, doc.companyId, f, m);
    if (!lu.ok) return lu;
    const p = lu.p;
    const specSansNumero = specRevisee(f, m, p.profil);
    // LE NUMÉRO MODIFIÉ (Direction, 14/10/2026) : jugé sur sa forme ici, sur son unicité ici ET sous verrou à l'écriture.
    const renum = jugerNumeroRevise(f, m.numero, specSansNumero.date, p.profil);
    if ("refus" in renum) return echec("MISSING_INPUT", renum.refus);
    if (renum.change) {
      const pris = await porteurDuNumero(prisma, { companyId: doc.companyId ?? f.societeId, kind: renum.kind, numero: renum.numero, registre: renum.registre ? { annee: renum.annee, numero: renum.registre.numero } : null, exclure: doc.id });
      if (pris) return echec("MISSING_INPUT", phraseNumeroPris(renum.numero, pris));
    }
    const numero = renum.change ? renum.numero : f.numero;
    // « SEUL LE NUMÉRO CHANGE » (Direction, 14/10/2026) : décidé ICI en comparant la pièce enregistrée et la saisie — la pièce
    // est alors régénérée TELLE QU'ENREGISTRÉE, numéro excepté, et garde son état (voir plus bas : pas de réaiguillage).
    const numeroSeul = renum.change && revisionDeNumeroSeul(f, specSansNumero, m);
    const spec: SpecDocumentCommercial = numeroSeul ? { ...f.spec, numero } : { ...specSansNumero, numero };
    const regles = verifierSpecCommerciale(spec);
    if (regles.bloquants.length > 0) return echec("MISSING_INPUT", `Révision refusée : ${regles.bloquants.slice(0, 4).join(" ; ")}`, { bloquants: regles.bloquants });
    const construit = await construireDocumentCommercial(spec, p.habillage);
    if (!construit.verification.ok || !construit.totaux) return echec("CAPABILITY_FAILURE", `Révision refusée : ${construit.verification.bloquants.slice(0, 4).join(" ; ")}`, { bloquants: construit.verification.bloquants });

    const version = f.version + 1;
    const motifs = [renum.change ? resumeChangementNumero(f.numero, numero) : null, numeroSeul ? MENTION_NUMERO_SEUL : null, opts.motif?.trim() || null].filter(Boolean);
    const resume = `v${version}${motifs.length ? ` — ${motifs.join(" ; ")}` : ""}`;
    // LA PIÈCE SE RÉVISE, PAS LE DRIVE D'UNE AUTRE PERSONNE (§118.152, §118.194) : son fichier vit dans le Drive de
    // qui l'a émise. Le droit vérifié plus haut — modifier cette pièce au registre ET engager sa société, ou la
    // délégation d'un dossier — couvre SON fichier, et lui seul : le port vérifie que le nœud est bien le sien.
    // Réservé à la délégation, il laissait offrir « Réviser la pièce » sur la fiche à une personne des Finances
    // que le Drive refusait ensuite — un geste offert puis retiré (§118.83).
    const piece = doc.id;
    const ecrit = await portsArtefact.documents.ecrireVersion(user.id, doc.driveNodeId, construit.octets, { mime: MIME_DOCX, resume, piece });
    let pdf = f.pdf;
    const avertissements = [...regles.avertissements, ...construit.verification.avertissements, ...manquesDIdentite(p.profil), ...(lu.avertissement ? [lu.avertissement] : [])];
    const conv = await pdfDeLaPiece(user, { nodeId: doc.driveNodeId, version: ecrit.version }, construit.octets);
    if (conv.ok) {
      if (pdf) {
        const v = await portsArtefact.documents.ecrireVersion(user.id, pdf.nodeId, conv.pdf, { mime: "application/pdf", resume, piece });
        pdf = { ...pdf, version: v.version, pages: conv.pages, methode: conv.methode };
      } else {
        const n = await portsArtefact.documents.creerFichier(user.id, { nom: nomFichier(numero, spec.tiers.nom, "pdf"), octets: conv.pdf, mime: "application/pdf" });
        pdf = { nodeId: n.nodeId, version: n.version, pages: conv.pages, methode: conv.methode };
      }
      const reserve = reservePdf(conv.methode, construit.surPapierEnTete);
      if (reserve) avertissements.push(reserve);
    } else avertissements.push(`PDF non produit : ${conv.error}`);
    const finale: Fabrique = {
      ...f, version, numero, spec, totaux: resumeTotaux(construit.totaux), docx: { nodeId: doc.driveNodeId, version: ecrit.version }, pdf, surPapierEnTete: construit.surPapierEnTete,
      papierEnTeteId: p.profil.papierEnTete?.id ?? null,
      historique: [...(f.historique ?? []), { version, le: new Date().toISOString(), par: user.id, resume, ...(numeroSeul ? { numeroSeul: true } : {}) }],
    };
    // LA VERSION LUE, ENCORE (§118.194) : la file sérialise dans ce processus ; entre deux processus, c'est
    // cette condition qui empêche la seconde révision de réécrire la première au registre. Le NOUVEAU NUMÉRO s'écrit dans la
    // MÊME transaction (registre, compteur, fiche) : pris entre-temps, rien de la révision n'est écrit au registre.
    let ecritAuRegistre: { count: number };
    try {
      ecritAuRegistre = await prisma.$transaction(async (tx) => {
        const n = await tx.legalDocument.updateMany({
          where: { id: doc.id, custom: { path: ["fabrique", "version"], equals: f.version } },
          data: {
            ...(renum.change ? { reference: numero } : {}),
            title: titreDocument({ type: f.type, numero, tiers: spec.tiers }), counterparty: spec.tiers.nom,
            amount: new Prisma.Decimal(construit.totaux!.totalTtc), startDate: new Date(`${spec.date}T00:00:00Z`), endDate: echeanceLegale(spec), updatedById: user.id,
            custom: { fabrique: finale } as unknown as Prisma.InputJsonValue,
          },
        });
        if (n.count === 1 && renum.change) await appliquerNumeroRevise(tx, renum, { id: doc.id, companyId: doc.companyId ?? f.societeId, type: f.type }, user.id);
        return n;
      });
    } catch (e) {
      if (e instanceof ReferenceRefusee) return echec("MISSING_INPUT", e.message);
      throw e;
    }
    if (ecritAuRegistre.count === 0) {
      return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} a été révisée entre-temps : rouvrez-la pour partir de sa version actuelle.`);
    }
    if (renum.change) {
      // Les fichiers du Drive portent le numéro dans leur nom : ils le suivent (au mieux — le registre fait foi).
      await prisma.driveNode.update({ where: { id: doc.driveNodeId }, data: { name: nomFichier(numero, spec.tiers.nom, "docx") } }).catch(sansBloquer("factory.reviserDocumentDrive.driveNode"));
      if (pdf) await prisma.driveNode.update({ where: { id: pdf.nodeId }, data: { name: nomFichier(numero, spec.tiers.nom, "pdf") } }).catch(sansBloquer("factory.reviserDocumentDrive.driveNode"));
      // TRACÉ : ancien → nouveau, qui, quand — une ligne du journal à part, lisible sans ouvrir la version.
      await recordAudit({
        actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id, field: "numero", oldValue: f.numero, newValue: numero,
        summary: `${LIBELLE_TYPE[f.type]} : ${resumeChangementNumero(f.numero, numero)} ${parQui(user, emission.canal)}${numeroSeul ? ` (${MENTION_NUMERO_SEUL})` : ""}${emission.delegation ? ` — autorisé par : ${emission.delegation}` : ""}`,
      });
    }
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Legal", entityType: "LEGAL_DOCUMENT", entityId: doc.id, summary: `${LIBELLE_TYPE[f.type]} ${numero} révisé ${parQui(user, emission.canal)} (${resume}) — ${formaterDzd(construit.totaux.totalTtc)}${emission.delegation ? ` — autorisé par : ${emission.delegation}` : ""}` });
    // UN BC RÉVISÉ SE RÉAIGUILLE (§118.148) : montant RELEVÉ après validation, il retourne au
    // centre ; corrigé à la demande du centre, il y est renvoyé. Le montant d'avant est celui de la
    // version précédente — c'est lui que le centre avait sous les yeux.
    let porteBC: PorteBC | null = null;
    let reserveBonDeCommande: string | null = null;
    if (numeroSeul) {
      // SEUL LE NUMÉRO A CHANGÉ : le BC garde son état — aucun réaiguillage, étapes de validation et signature conservées.
      avertissements.push(phraseNumeroSeul({ signe: Boolean(doc.signedAt) }));
    } else if (f.type === "BON_DE_COMMANDE") {
      // Une RÉVISION est une nouvelle version du fichier : ce n'est plus la pièce que les Finances
      // ont signée, même à montant égal (§118.149).
      const a = await aiguillerBC(doc.id, { acteurId: user.id, modifie: true, montantAvant: f.totaux?.totalTtc ?? null, pieceRevisee: true });
      porteBC = a.porte;
      reserveBonDeCommande = reserveDuBC(a);
      if (reserveBonDeCommande) avertissements.push(reserveBonDeCommande);
    }
    return {
      ok: true, dejaEmis: false, repris: false, legalDocumentId: doc.id, reference: numero, type: f.type, version,
      societe: { id: p.profil.societe.id, nom: p.profil.societe.nom }, tiers: spec.tiers.nom,
      docx: { nodeId: doc.driveNodeId, nom: nomFichier(numero, spec.tiers.nom, "docx"), version: ecrit.version },
      pdf: pdf ? { nodeId: pdf.nodeId, nom: nomFichier(numero, spec.tiers.nom, "pdf"), pages: pdf.pages, methode: pdf.methode ?? "rendu" } : null,
      totaux: finale.totaux, surPapierEnTete: construit.surPapierEnTete, avertissements, reglesAppliquees: p.profil.reglesAppliquees, porteBC, reserveBonDeCommande, numeroSeul, ms: Date.now() - debut,
    };
  });
}

/** L'aperçu tel que l'ÉCRAN du composeur le reçoit (sérialisable : ni octets, ni spécification entière). */
export interface ApercuPiece {
  ok: true;
  societe: { id: string; nom: string };
  numeroProchain: string;
  motif: string | null;
  /** Le numéro vient du registre commun NNN/DG/AAAA de la société : il peut être choisi à l'émission. */
  surRegistre: boolean;
  papierEnTete: { id: string; nom: string } | null;
  identiteIncomplete: string[];
  totaux: { totalHt: number; totalTaxes: number; totalTva: number; timbre: number; totalTtc: number; enLettres: string; taxes: { libelle: string; taux: number; montant: number }[]; tva: { taux: number; montant: number }[] } | null;
  bloquants: string[];
  avertissements: string[];
  peutEmettre: boolean;
  pdfParEditeur: boolean;
  /** Ce que la société émettrice imprime par défaut — l'écran le pré-remplit, chacun le change pour sa pièce. */
  coordonneesSociete: { adresse: string | null; telephone: string | null; email: string | null };
  /** Le signataire que la pièce imprimera (marque, profil, ou celui choisi) — l'écran le pré-remplit. */
  signataire: { nom: string; qualite: string | null } | null;
  /** Vrai quand l'aperçu est celui d'une RÉVISION : le numéro est celui de la pièce, pas un numéro prévu. */
  revision: boolean;
}

/** L'aperçu de la fabrique, ramené à ce que l'écran lit — une conversion, pour l'aperçu de Legal comme pour celui d'un poste. */
export function apercuPourEcran(r: ApercuDocument, revision: boolean): ApercuPiece {
  return {
    ok: true, revision, coordonneesSociete: r.coordonneesSociete,
    signataire: r.spec.signataire ? { nom: r.spec.signataire.nom, qualite: r.spec.signataire.qualite ?? null } : null,
    societe: r.societe, numeroProchain: r.numeroProchain, motif: r.motif, surRegistre: r.surRegistre, papierEnTete: r.papierEnTete, identiteIncomplete: r.identiteIncomplete,
    totaux: r.totaux
      ? {
        totalHt: r.totaux.totalHt, totalTaxes: r.totaux.totalTaxes, totalTva: r.totaux.totalTva, timbre: r.totaux.timbre, totalTtc: r.totaux.totalTtc, enLettres: r.totaux.enLettres,
        taxes: r.totaux.taxes.map((x) => ({ libelle: x.libelle, taux: x.taux, montant: x.montant })),
        tva: r.totaux.tva.map((x) => ({ taux: x.taux, montant: x.montant })),
      }
      : null,
    bloquants: r.bloquants, avertissements: r.avertissements, peutEmettre: r.peutEmettre, pdfParEditeur: r.pdfParEditeur,
  };
}

/**
 * L'APERÇU D'UNE RÉVISION — la MÊME composition que `reviserDocumentDrive` (`specRevisee`), jouée à blanc : totaux, papier,
 * ce qui bloquerait, et le PDF tel qu'il sera imprimé sous SON numéro. Rien n'est écrit. Les mêmes portes que la révision :
 * une pièce qu'on ne pourrait pas réviser ne se prévisualise pas non plus (§118.83).
 */
export async function previsualiserRevision(
  user: CurrentUser,
  opts: { legalDocumentId: string; modifications: ModificationsDocument; avecPdf?: boolean },
  /** Comme la révision : sous la délégation d'un dossier (le demandeur d'un poste Ad & Pro), les droits Legal cèdent. */
  emission: Pick<OptionsEmission, "delegation"> = {},
): Promise<ApercuDocument | EchecFabrique> {
  const doc = await prisma.legalDocument.findUnique({ where: { id: opts.legalDocumentId }, select: { id: true, companyId: true, status: true, custom: true, signedAt: true } });
  const f = doc ? fabriqueDe(doc.custom) : null;
  if (!doc || !f) return echec("NOT_FOUND", "Cette pièce n'existe pas, ou n'a pas été émise par la fabrique (seules celles-ci se révisent).");
  if (f.type === "FACTURE" || f.type === "AVOIR") return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} est une pièce fiscale émise : elle ne se réécrit pas.`);
  if (doc.status !== "ACTIVE") return echec("CAPABILITY_FAILURE", `La pièce ${f.numero} est ${doc.status === "CANCELLED" ? "annulée" : "close"} : elle ne se révise plus.`);
  if (!emission.delegation && !peutEcrire(user, "UPDATE", f.type)) return echec("MISSING_PERMISSION", "Réviser cette pièce exige le droit de modifier dans Legal.");
  if (!emission.delegation && !(await canEditCompanyId(user.id, doc.companyId))) return echec("MISSING_PERMISSION", "Cette pièce appartient à une société que vous ne pouvez pas engager.");
  const m = await modificationsControlees(user, opts.modifications ?? {}, f.type);
  const lu = await profilDeLaRevision(user, doc.companyId, f, m);
  if (!lu.ok) return lu;
  const { profil, habillage } = lu.p;
  const specSansNumero = specRevisee(f, m, profil);
  // LE NUMÉRO MODIFIÉ s'affiche (et s'imprime) dès l'aperçu ; pris ou mal écrit, il bloque comme à la révision.
  const renum = jugerNumeroRevise(f, m.numero, specSansNumero.date, profil);
  let refusNumero: string | null = "refus" in renum ? renum.refus : null;
  if (!("refus" in renum) && renum.change) {
    const pris = await porteurDuNumero(prisma, { companyId: doc.companyId ?? f.societeId, kind: renum.kind, numero: renum.numero, registre: renum.registre ? { annee: renum.annee, numero: renum.registre.numero } : null, exclure: doc.id });
    if (pris) refusNumero = phraseNumeroPris(renum.numero, pris);
  }
  const numero = !("refus" in renum) && renum.change && !refusNumero ? renum.numero : f.numero;
  // Seul le numéro change : la pièce enregistrée, telle quelle, au nouveau numéro — et l'écran dit que le BC garde son état.
  const numeroSeul = numero !== f.numero && revisionDeNumeroSeul(f, specSansNumero, m);
  const spec: SpecDocumentCommercial = numeroSeul ? { ...f.spec, numero } : { ...specSansNumero, numero };
  const commun = {
    ok: true as const, societe: { id: profil.societe.id, nom: profil.societe.nom }, numeroProchain: numero, motif: null, surRegistre: false,
    papierEnTete: profil.papierEnTete, identiteIncomplete: profil.identiteIncomplete, spec, pdfParEditeur: convertConfigured(), coordonneesSociete: coordonneesParDefaut(profil),
  };
  const refusDate = refusDateRevisee(f, m.date);
  const regles = verifierSpecCommerciale(spec);
  const avertissements = [...(numeroSeul ? [phraseNumeroSeul({ signe: Boolean(doc.signedAt) })] : []), ...manquesDIdentite(profil), ...(lu.avertissement ? [lu.avertissement] : [])];
  if (refusDate || refusNumero || regles.bloquants.length > 0) {
    return { ...commun, totaux: null, bloquants: [...(refusDate ? [refusDate] : []), ...(refusNumero ? [refusNumero] : []), ...regles.bloquants], avertissements: [...regles.avertissements, ...avertissements], peutEmettre: false, ...(opts.avecPdf ? { pdf: null, pdfErreur: "Le rendu n'est pas possible tant que la révision est refusée." } : {}) };
  }
  const essai = await construireDocumentCommercial(spec, habillage);
  const rendu = opts.avecPdf && essai.verification.ok ? await docxToPdf(essai.octets) : null;
  return {
    ...commun, totaux: essai.totaux, bloquants: essai.verification.bloquants, avertissements: [...essai.verification.avertissements, ...avertissements], peutEmettre: essai.verification.ok,
    ...(opts.avecPdf ? (rendu && rendu.ok ? { pdf: { octets: rendu.pdf, pages: rendu.pages } } : { pdf: null, pdfErreur: rendu && !rendu.ok ? rendu.error : "Le rendu n'est pas possible tant que la révision est refusée." }) : {}),
  };
}
