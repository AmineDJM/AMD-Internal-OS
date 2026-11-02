import { prisma } from "@/lib/prisma";
import { peutAnnuaire, userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { createLegalDocument, updateLegalDocument } from "@/lib/actions/legal-actions";
import { createLegalFolder, moveLegalDocuments } from "@/lib/actions/legal-folder-actions";
import { createAmendment } from "@/lib/actions/pch-market-actions";
import {
  contactsDuPerimetre, dossiersJuridiques, partieParNom, piecesJuridiquesLisibles, piecesJuridiquesModifiables, societeDeRattachement, societeDeRattachementId, societesDe,
} from "@/lib/actions/internes/legal/registre-lecture";
import { texteDuFichierLu } from "@/lib/actions/internes/documents/fichiers-lus";
import { createCompanyContact } from "@/lib/actions/company-contact-actions";
import { findPeople } from "@/platform/ia/outils/arguments";
import { candidatsParLesMots } from "@/platform/ia/drive";
import { champs, dzd, liste, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import {
  dateJuridique, datesDuTexte, dossierCanonique, estInstitutionPublique, FAMILLE_PAR_DEFAUT, familleDe, montantJuridique, NATURES_A_CIRCUIT,
  replierTexte, type FamillePiece,
} from "../../domaine/juridique/classement";
import { resoudrePiece } from "./pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 — RANGER DANS LE JURIDIQUE, EN UNE CARTE (décision 0053).
 *
 * Avant : ranger un contrat du Drive passait par DEUX capacités génériques (`attachDriveNodeToLegal`, R4, sans dossier
 * ni montant ; puis `moveLegalDocuments`) — deux cartes sur deux tours (une carte par tour), une partie exigée à
 * l'annuaire sans qu'on sache laquelle, des dates que le modèle devait recopier sans les avoir lues. Ici, UNE carte :
 *   • chaque pièce : sa NATURE et son DOSSIER canoniques (`domaine/juridique/classement.ts`), ses DATES (données par le
 *     modèle, sinon LUES sur la pièce, la preuve dite), sa PARTIE (résolue à l'annuaire ; absente : ajoutée — si la
 *     personne a le droit d'écrire l'annuaire — sinon le refus le dit), son ENTITÉ (une société de son périmètre) ;
 *   • l'exécution passe par les ACTIONS DE L'ÉCRAN (`createLegalFolder`, `createCompanyContact`, `createLegalDocument`,
 *     `moveLegalDocuments`) sous la session de la personne : RBAC, cloisonnement et lecteurs y sont revérifiés ;
 *   • le geste est JOURNALISÉ (J7, `executerOperationJournalisee`) : « annule » défait tout — fiches, dossier créé,
 *     contact ajouté — et une mission de fond (moteur des travaux) peut l'appeler en GESTE pour un lot.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MOTS_VIDES = new Set(["les", "des", "une", "pour", "avec", "dans", "sur", "fiche", "piece", "document", "juridique", "registre", "mon", "mes", "son", "ses"]);

/** Au-delà, la carte deviendrait illisible : le reste se range en mission (lot). */
export const PIECES_PAR_CARTE = 30;
/** La lecture des pièces sans dates données coûte : bornée par carte. */
const LECTURES_MAX = 30;

interface PieceARanger {
  driveNodeId: string;
  fichier: string;
  titre: string;
  nature: string;
  famille: string;
  partieId: string | null;
  partieNom: string | null;
  creerPartie: boolean;
  sphere: "PRIVE" | "PUBLIC";
  debut: string | null;
  fin: string | null;
  montant: string | null;
  reference: string | null;
  notes: string | null;
  dossier: string;
  dossierId: string | null;
  existantId: string | null;
  entiteId: string | null;
  preuve: string | null;
  /** Un AVENANT : le contrat qu'il modifie (au registre, lisible) — créé par l'action de l'ERP `createAmendment`. */
  amendsId?: string | null;
}

const ouverte = (u: CurrentUser) => userCan(u, "LEGAL", "CREATE");

/** La partie : celle que la personne (ou le modèle) nomme, sinon un contact de l'annuaire CITÉ dans la pièce, seul. */
async function partieDe(user: CurrentUser, nom: string, texteLu: string): Promise<
  { id: string; nom: string } | { creer: string } | { erreur: string } | null
> {
  if (nom) {
    const r = await partieParNom(user, nom);
    if (r.ok) return { id: r.id, nom: r.name };
    if (/ne figure pas/.test(r.error)) {
      return peutAnnuaire(user, estInstitutionPublique(nom) ? "PARTENAIRES_PUBLICS" : "PARTENAIRES", "CREATE")
        ? { creer: nom.trim().slice(0, 160) }
        : { erreur: `${r.error} (vous n'avez pas le droit d'écrire l'annuaire : demandez aux Moyens généraux de l'ajouter).` };
    }
    return { erreur: r.error };
  }
  if (!texteLu) return null;
  const contacts = await contactsDuPerimetre(user);
  const t = replierTexte(texteLu);
  // La société elle-même est citée dans toutes ses pièces (« entre Adventum Pharma et … ») : elle n'est pas « l'autre » partie.
  const soi = replierTexte(await societeDe(user));
  const cites = contacts.filter((c) => {
    const n = replierTexte(c.name);
    return n.length >= 4 && t.includes(n) && !(soi && (n.includes(soi) || soi.includes(n)));
  });
  return cites.length === 1 ? { id: cites[0]!.id, nom: cites[0]!.name } : null;
}

/** Le nom de la société de la personne (son entité de rattachement), pour une pièce interne. */
const societeDe = (user: CurrentUser): Promise<string> => societeDeRattachement(user);

async function dossierExistant(user: CurrentUser, nom: string): Promise<string | null> {
  return (await dossiersJuridiques(user, nom))[0]?.id ?? null;
}

async function entiteDe(user: CurrentUser, nom: string): Promise<{ id: string; nom: string } | { erreur: string } | null> {
  if (!nom) return null;
  const mine = await societesDe(user);
  const q = replierTexte(nom);
  // « Adventum Pharma SPA » désigne « Adventum Pharma » (et l'inverse) : la forme juridique ne départage pas (banc DOC-30).
  const sansForme = (x: string) => replierTexte(x).replace(/\b(spa|sarl|eurl|sas|sa|snc|groupe)\b/g, "").replace(/\s+/g, " ").trim();
  const hits = mine.filter((c) => { const n = sansForme(c.name); const k = sansForme(q); return n === k || n.includes(k) || k.includes(n) || replierTexte((c as { shortName?: string | null }).shortName ?? "") === q; });
  if (hits.length === 1) return { id: hits[0]!.id, nom: hits[0]!.name };
  return { erreur: hits.length ? `L'entité « ${nom} » est ambiguë (${hits.map((h) => h.name).join(", ")}).` : `L'entité « ${nom} » n'est pas dans votre périmètre.` };
}

/**
 * UN DOSSIER DU DRIVE, rangé d'un coup (banc DOC-10 : « toutes les pièces de mon dossier À classer ») : ses fichiers (≤ 30,
 * sous-dossiers exclus) deviennent les pièces du lot — un dossier de la personne ou partagé avec elle, droits revérifiés
 * pièce par pièce par `resoudrePiece`.
 */
async function fichiersDuDossierDrive(user: CurrentUser, nom: string, explicite: boolean): Promise<{ ids: string[] } | { erreur: string } | null> {
  if (!nom.trim()) return null;
  const q = replierTexte(nom);
  const dossiers = (await prisma.driveNode.findMany({
    where: { type: "FOLDER", isTrashed: false, OR: [{ ownerId: user.id }, { shares: { some: { userId: user.id } } }] },
    select: { id: true, name: true }, take: 500,
  // Désigné comme dossier : le nom peut être partiel ; sinon (un « fichier » sans extension), seul le nom EXACT d'un dossier compte —
  // « range le contrat » ne doit jamais ranger tout un dossier « Contrats ».
  })).filter((d) => replierTexte(d.name) === q || (explicite && replierTexte(d.name).includes(q)));
  if (!dossiers.length) return null;
  if (dossiers.length > 1 && !dossiers.some((d) => replierTexte(d.name) === q)) return { erreur: `Plusieurs dossiers du Drive correspondent à « ${nom} » : ${dossiers.slice(0, 5).map((d) => d.name).join(", ")}.` };
  const d = dossiers.find((x) => replierTexte(x.name) === q) ?? dossiers[0]!;
  const fichiers = await prisma.driveNode.findMany({ where: { parentId: d.id, type: "FILE", isTrashed: false }, select: { id: true }, orderBy: { name: "asc" }, take: 200 });
  return { ids: fichiers.map((f) => f.id) };
}

/**
 * LA PIÈCE DÉSIGNÉE, avec une HYPOTHÈSE RAISONNABLE plutôt qu'une question (banc DOC-30 : « range le contrat Pharmalliance »
 * face à l'original, sa COPIE et l'AVENANT) : parmi les fichiers dont le nom porte tous les mots, ceux de la MÊME FAMILLE que
 * ce qui est demandé (un avenant n'est pas « le contrat ») ; deux contenus IDENTIQUES ne font qu'un — l'original, pas la
 * copie. Un seul reste : il est pris, et l'hypothèse est DITE sur la carte. Sinon, la question d'origine.
 */
async function pieceDesignee(user: CurrentUser, ref: string, nature: string): Promise<{ id: string; nom: string; hypothese?: string } | { erreur: string }> {
  const p = await resoudrePiece(user, ref);
  if (!("erreur" in p)) return p;
  // UNE PIÈCE DÉJÀ AU REGISTRE, désignée par SON TITRE (banc DOC-14 : « la police d'assurance flotte automobile », dont le
  // fichier s'appelle « Police flotte automobile SAA.pdf ») : la fiche lisible, et son fichier s'il se voit au Drive.
  if (!/Plusieurs/.test(p.erreur)) {
    const f = await ficheJuridique(user, ref);
    if ("erreur" in f) return p;
    if (!f.fiche.driveNodeId) return { erreur: `la fiche « ${f.fiche.title} » est au registre sans fichier : pour la classer, modifier_fiche_juridique avec son nouveau \`dossier\`.` };
    const n = await resoudrePiece(user, f.fiche.driveNodeId);
    return "erreur" in n ? { erreur: `la fiche « ${f.fiche.title} » est au registre, mais son fichier ne vous est pas lisible au Drive : modifier_fiche_juridique la classe sans lui.` }
      : { ...n, hypothese: `« ${ref} » : la pièce du registre « ${f.fiche.title} » (fichier « ${n.nom} »).` };
  }
  const voulu = familleDe(nature, ref);
  let c = await candidatsParLesMots(user, ref);
  if (voulu) c = c.filter((x) => (familleDe(x.name) ?? FAMILLE_PAR_DEFAUT).cle === voulu.cle);
  const blobs = new Map((await prisma.fileVersion.findMany({ where: { nodeId: { in: c.map((x) => x.id) } }, orderBy: { version: "desc" }, select: { nodeId: true, blobId: true } }))
    .reverse().map((v) => [v.nodeId, v.blobId]));
  const COPIE = /\bcopie\b|\bcopy\b|\(\d+\)|- copie/i;
  c = c.filter((x) => !(COPIE.test(x.name) && c.some((y) => y.id !== x.id && !COPIE.test(y.name) && blobs.get(y.id) === blobs.get(x.id))));
  if (c.length !== 1) return p;
  return { id: c[0]!.id, nom: c[0]!.name, hypothese: `« ${ref} » : j'ai pris « ${c[0]!.name} » (l'original${voulu ? `, un ${voulu.libelle.toLowerCase()}` : ""}) — dites-le si c'est un autre fichier.` };
}

/** Les pièces désignées : une liste `documents` (objets), sinon les champs à plat pour une seule pièce. */
function piecesDemandees(e: Record<string, unknown>): Record<string, unknown>[] {
  const d = e.documents;
  if (Array.isArray(d) && d.length) return d.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (typeof d === "string" && d.trim().startsWith("[")) {
    try { const v = JSON.parse(d) as unknown; if (Array.isArray(v)) return v as Record<string, unknown>[]; } catch { /* une liste de noms, plus bas */ }
  }
  const fichiers = liste(e, "fichiers");
  if (fichiers.length) return fichiers.map((fichier) => ({ ...e, fichier }));
  return texte(e, "fichier") ? [e] : [];
}

async function proposerRangement(e: Record<string, unknown>, user: CurrentUser): Promise<PropositionOperation> {
  let demandees = piecesDemandees(e);
  // Un dossier du Drive nommé (`dossierDrive`), ou un « fichier » qui est en fait un DOSSIER : ses pièces deviennent le lot.
  const nomDossierDrive = texte(e, "dossierDrive") || (demandees.length === 1 ? texte(demandees[0]!, "fichier") : "");
  const explicite = Boolean(texte(e, "dossierDrive"));
  const duDossier = nomDossierDrive && (explicite || !/\.[a-z0-9]{2,5}$/i.test(nomDossierDrive)) ? await fichiersDuDossierDrive(user, nomDossierDrive, explicite) : null;
  if (duDossier && "erreur" in duDossier) return { erreur: duDossier.erreur };
  if (duDossier) {
    if (!duDossier.ids.length) return { erreur: `Le dossier « ${nomDossierDrive} » du Drive ne contient aucun fichier.` };
    // Chaque pièce du dossier garde SA nature et SES dates (lues) ; seul un dossier de classement demandé est commun.
    const dossierCommun = demandees.length === 1 ? texte(demandees[0]!, "dossier") : "";
    demandees = duDossier.ids.map((id) => ({ fichier: id, ...(dossierCommun ? { dossier: dossierCommun } : {}) }));
  }
  if (!demandees.length) return { manque: ["le ou les documents à ranger (glissez-les dans la conversation ou nommez-les)"] };
  if (demandees.length > PIECES_PAR_CARTE) {
    return { erreur: `${demandees.length} pièces : au-delà de ${PIECES_PAR_CARTE} par carte, lance une MISSION (lancer_un_travail) qui range le lot par paquets de ${PIECES_PAR_CARTE} avec ce même geste.` };
  }
  const entite = await entiteDe(user, texte(e, "entite"));
  if (entite && "erreur" in entite) return { erreur: entite.erreur };
  const lecteurs: { id: string; nom: string }[] = [];
  for (const n of liste(e, "lecteurs")) {
    const p = (await findPeople(n, 3)).filter((x) => x.id !== user.id);
    if (p.length !== 1) return { erreur: `Lecteur « ${n} » ${p.length ? "ambigu" : "introuvable"} dans l'annuaire interne.` };
    lecteurs.push({ id: p[0]!.id, nom: p[0]!.name });
  }

  const pieces: PieceARanger[] = [];
  const avertissements: string[] = [];
  let lectures = 0;
  for (const d of demandees) {
    const ref = texte(d, "fichier") || texte(d, "document") || texte(d, "id");
    const p = await pieceDesignee(user, ref, texte(d, "nature"));
    if ("erreur" in p) return { erreur: `« ${ref || "?"} » : ${p.erreur}` };
    if (p.hypothese) avertissements.push(p.hypothese);
    if (pieces.some((x) => x.driveNodeId === p.id)) continue;
    const famille: FamillePiece = familleDe(texte(d, "nature"), texte(d, "titre"), p.nom) ?? FAMILLE_PAR_DEFAUT;
    if (NATURES_A_CIRCUIT.includes(famille.nature)) {
      return { erreur: `« ${p.nom} » est un(e) ${famille.libelle.toLowerCase()} : il passe par son circuit (preparer_bon_de_commande / preparer_bc_depuis_devis pour un BC, l'écran Factures pour une facture), pas par un simple rangement.` };
    }
    let debut = dateJuridique(texte(d, "debut") || texte(d, "dateDebut"));
    let fin = dateJuridique(texte(d, "fin") || texte(d, "echeance") || texte(d, "dateFin"));
    let preuve: string | null = null;
    const nomPartie = texte(d, "partie");
    let lu = "";
    if ((!debut || !fin || !nomPartie) && lectures < LECTURES_MAX) {
      lectures++;
      lu = await texteDuFichierLu(user, p.id, p.nom);
      const dt = datesDuTexte(lu);
      if (!debut && dt.debut) { debut = dt.debut; preuve = dt.preuve; }
      if (!fin && dt.fin) { fin = dt.fin; preuve = dt.preuve; }
    }
    if (debut && fin && fin < debut) return { erreur: `« ${p.nom} » : la fin (${fin}) précède le début (${debut}) — vérifiez les dates.` };
    // Une pièce INTERNE (statuts, PV) : la partie est la société elle-même — sa fiche à l'annuaire (le registre en exige une).
    const partie = await partieDe(user, nomPartie || (famille.partieAttendue ? "" : await societeDe(user)), lu);
    if (partie && "erreur" in partie) return { erreur: `« ${p.nom} » : ${partie.erreur}` };
    if (!partie && famille.partieAttendue && famille.nature !== "QUOTE") {
      return { manque: [`l'autre partie de « ${p.nom} » (le cocontractant, ou l'organisme qui l'a délivré)`] };
    }
    const dossier = dossierCanonique(texte(d, "dossier") || texte(e, "dossier"), famille);
    const existant = await prisma.legalDocument.findFirst({ where: { driveNodeId: p.id, status: { not: "CANCELLED" } }, select: { id: true, folder: { select: { name: true } } } });
    if (existant) {
      const ok = (await piecesJuridiquesModifiables(user, [existant.id])).has(existant.id);
      if (!ok) return { erreur: `« ${p.nom} » figure déjà au registre juridique, sur une fiche que vous ne pouvez pas modifier.` };
      avertissements.push(`« ${p.nom} » est déjà au registre${existant.folder ? ` (dossier « ${existant.folder.name} »)` : ""} : sa fiche est seulement rangée dans « ${dossier} ».`);
    }
    // UN AVENANT naît sur son contrat (l'ERP le crée par `createAmendment`) : le contrat de la même partie, au registre, lisible.
    let amendsId: string | null = null;
    if (famille.nature === "AMENDMENT" && !existant) {
      const partieId = partie && "id" in partie ? partie.id : null;
      const parent = partieId ? (await piecesJuridiquesLisibles(user, { kind: { in: ["CONTRACT", "AGREEMENT"] }, status: { not: "CANCELLED" }, counterpartyIds: { has: partieId } }, 10))[0] : undefined;
      if (!parent) return { manque: [`le contrat que modifie « ${p.nom} » (aucun contrat ${partie ? `de ${"id" in partie ? partie.nom : partie.creer} ` : ""}au registre : rangez-le d'abord)`] };
      amendsId = parent.id;
      avertissements.push(`« ${p.nom} » : avenant au contrat « ${parent.title} ».`);
    }
    const montant = montantJuridique(texte(d, "montant"));
    pieces.push({
      driveNodeId: p.id, fichier: p.nom,
      titre: (texte(d, "titre") || p.nom.replace(/\.[a-z0-9]{2,5}$/i, "")).slice(0, 240),
      nature: famille.nature, famille: famille.libelle,
      partieId: partie && "id" in partie ? partie.id : null,
      // Les statuts, PV de la société elle-même : la société EST la partie (aucune fiche d'annuaire exigée).
      partieNom: partie ? ("id" in partie ? partie.nom : partie.creer) : null,
      creerPartie: !!partie && "creer" in partie,
      sphere: partie && "creer" in partie && estInstitutionPublique(partie.creer) ? "PUBLIC" : "PRIVE",
      debut, fin, montant: montant !== null ? String(montant) : null,
      reference: texte(d, "reference") || null,
      notes: [famille.nature === "OTHER" || famille.nature === "LICENSE" ? `Nature : ${famille.libelle}.` : null, texte(d, "notes") || null].filter(Boolean).join(" ") || null,
      dossier, dossierId: await dossierExistant(user, dossier), existantId: existant?.id ?? null,
      entiteId: entite && "id" in entite ? entite.id : null, preuve, amendsId,
    });
  }

  const nouveauxDossiers = [...new Set(pieces.filter((p) => !p.dossierId).map((p) => p.dossier))];
  const nouvellesParties = [...new Set(pieces.filter((p) => p.creerPartie).map((p) => p.partieNom!))];
  if (nouveauxDossiers.length) avertissements.push(`Dossier(s) créé(s) au Juridique : ${nouveauxDossiers.map((d) => `« ${d} »`).join(", ")}.`);
  if (nouvellesParties.length) avertissements.push(`Ajouté(s) à l'annuaire des partenaires : ${nouvellesParties.join(", ")}.`);
  for (const p of pieces.filter((x) => x.preuve)) avertissements.push(`« ${p.fichier} » : dates lues sur la pièce (« ${p.preuve!.slice(0, 120)} ») — vérifiez-les.`);
  for (const p of pieces.filter((x) => !x.fin && x.nature !== "OTHER")) avertissements.push(`« ${p.fichier} » : aucune échéance lue — enregistré sans échéance (jamais rappelé).`);
  if (lecteurs.length) avertissements.push(`Restreint à : ${lecteurs.map((l) => l.nom).join(", ")} (et vous).`);

  const ligne = (p: PieceARanger) => [
    p.famille, p.partieNom ?? (p.nature === "QUOTE" ? null : "la société"),
    p.debut || p.fin ? `${p.debut ?? "…"} → ${p.fin ?? "sans échéance"}` : null, p.montant ? dzd(Number(p.montant)) : null, `dossier « ${p.dossier} »`,
  ].filter(Boolean).join(" · ");
  return {
    carte: {
      title: pieces.length === 1 ? `Ranger au Juridique — ${pieces[0]!.titre}` : `Ranger ${pieces.length} pièces au Juridique`,
      fields: champs([
        ...(pieces.length === 1
          ? ([["Pièce", pieces[0]!.fichier], ["Titre", pieces[0]!.titre], ["Nature", pieces[0]!.famille], ["Partie", pieces[0]!.partieNom ?? "la société (pièce interne)"],
            ["Début", pieces[0]!.debut], ["Échéance", pieces[0]!.fin ?? "sans échéance"], ["Montant", pieces[0]!.montant ? dzd(Number(pieces[0]!.montant)) : null],
            ["Référence", pieces[0]!.reference], ["Dossier", pieces[0]!.dossier]] as [string, string | null][])
          : pieces.map((p, i) => [`${i + 1}. ${p.fichier}`, ligne(p)] as [string, string])),
        ["Entité", entite && "nom" in entite ? entite.nom : null],
      ]),
      warnings: [...avertissements, "Le fichier reste dans le Drive : la fiche juridique pointe vers lui (aucune copie). « Annule » défait tout."],
      libelleBouton: pieces.length === 1 ? "Ranger au Juridique" : `Ranger les ${pieces.length} pièces`,
    },
    args: { pieces: JSON.stringify(pieces), lecteurs: JSON.stringify(lecteurs.map((l) => l.id)) },
  };
}

const fd = (o: Record<string, string | string[] | null | undefined>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else if (v) f.set(k, v);
  }
  return f;
};

async function executerRangement(a: Record<string, string | null>, user: CurrentUser) {
  let pieces: PieceARanger[];
  let lecteurs: string[];
  try { pieces = JSON.parse(a.pieces ?? "[]") as PieceARanger[]; lecteurs = JSON.parse(a.lecteurs ?? "[]") as string[]; } catch { return { ok: false, error: "Carte illisible." }; }
  const dossiers = new Map<string, string>();
  const parties = new Map<string, string>();
  const faits: string[] = [];
  for (const p of pieces) {
    const cleDossier = replierTexte(p.dossier);
    let dossierId = dossiers.get(cleDossier) ?? p.dossierId ?? (await dossierExistant(user, p.dossier));
    if (!dossierId) {
      // Le dossier créé appartient à l'ENTITÉ de la pièce (celle demandée, sinon celle de la personne) — `createLegalFolder` revérifie le périmètre.
      const entite = p.entiteId ?? (await societeDeRattachementId(user));
      const r = await createLegalFolder(undefined, fd({ name: p.dossier, companyId: entite, description: "Créé par Adventum IA (rangement)." }));
      if (!r.ok || !r.id) return { ok: false, error: `${faits.length ? `${faits.join(" ; ")} — puis ` : ""}dossier « ${p.dossier} » refusé : ${r.error ?? "?"}` };
      dossierId = r.id;
    }
    dossiers.set(cleDossier, dossierId);
    let partieId = p.partieId;
    if (p.creerPartie && p.partieNom) {
      partieId = parties.get(replierTexte(p.partieNom)) ?? null;
      if (!partieId) {
        const r = await createCompanyContact(undefined, fd({ name: p.partieNom, sphere: p.sphere, kind: p.sphere === "PUBLIC" ? "Organisme public" : "Partenaire", notes: "Ajouté par Adventum IA en rangeant une pièce juridique." }));
        if (!r.ok || !r.id) return { ok: false, error: `Ajout de « ${p.partieNom} » à l'annuaire refusé : ${r.error ?? "?"}` };
        partieId = r.id;
      }
      parties.set(replierTexte(p.partieNom), partieId);
    }
    let ficheId: string;
    if (p.existantId) {
      const r = await moveLegalDocuments(fd({ documentId: [p.existantId], folderId: dossierId }));
      if (!r.ok) return { ok: false, error: `« ${p.fichier} » : ${r.error ?? "rangement refusé"}` };
      ficheId = p.existantId;
    } else if (p.amendsId) {
      const r = await createAmendment(fd({ contractId: p.amendsId, title: p.titre, effectiveAt: p.debut, reference: p.reference, notes: p.notes }));
      if (!r.ok || !r.id) return { ok: false, error: `« ${p.fichier} » (avenant) refusé : ${r.error ?? "?"}` };
      ficheId = r.id;
      // Le fichier, le dossier, la partie et l'échéance — que l'action des avenants ne porte pas. Porte d'écriture : la fiche
      // vient d'être créée par la personne, son droit de la modifier est rejugé par la règle des pièces Legal.
      const peut = (await piecesJuridiquesModifiables(user, [ficheId])).has(ficheId);
      if (peut) {
        const partie = partieId ? await prisma.companyContact.findUnique({ where: { id: partieId }, select: { name: true } }) : null;
        await prisma.legalDocument.update({ where: { id: ficheId }, data: {
          driveNodeId: p.driveNodeId, folderId: dossierId, endDate: p.fin ? new Date(p.fin) : null,
          ...(partieId ? { counterpartyIds: [partieId], counterparty: partie?.name ?? null } : {}), updatedById: user.id,
        } });
      }
    } else {
      const r = await createLegalDocument(undefined, fd({
        title: p.titre, kind: p.nature, counterpartyIds: partieId ? [partieId] : [], startDate: p.debut, endDate: p.fin, amount: p.montant,
        reference: p.reference, notes: p.notes, folderId: dossierId, driveNodeId: p.driveNodeId, readerId: lecteurs,
      }));
      if (!r.ok || !r.id) return { ok: false, error: `${faits.length ? `${faits.join(" ; ")} — puis ` : ""}« ${p.fichier} » refusé : ${r.error ?? "?"}` };
      ficheId = r.id;
    }
    if (p.entiteId) {
      const mine = (await societesDe(user)).map((c) => c.id);
      // porte d'écriture : l'entité est revérifiée dans le périmètre de la personne, la fiche vient d'être créée par elle.
      if (mine.includes(p.entiteId)) await prisma.legalDocument.update({ where: { id: ficheId }, data: { companyId: p.entiteId } });
    }
    faits.push(`« ${p.titre} » → ${p.dossier}`);
  }
  const lien = pieces.length === 1 ? `/legal/${await premiereFiche(pieces[0]!)}` : "/legal";
  return { ok: true, message: `${pieces.length} pièce(s) rangée(s) au Juridique : ${faits.join(" ; ")}.`, link: lien, revalidate: ["/legal"] };
}

async function premiereFiche(p: PieceARanger): Promise<string> {
  return (await prisma.legalDocument.findFirst({ where: { driveNodeId: p.driveNodeId }, select: { id: true } }))?.id ?? "";
}

export const RANGER_JURIDIQUE: OperationIA = {
  nom: "ranger_au_juridique",
  module: "LEGAL",
  libelle: "Rangement juridique préparé",
  description:
    "RANGE une ou plusieurs pièces du Drive (ou glissées dans la conversation) AU REGISTRE JURIDIQUE, à leur place : contrat, avenant, "
    + "statuts, PV, agrément, AMM, licence, assurance, bail, convention, NDA, devis, attestation. Une SEULE carte pour tout le lot (≤ 30), aussi en GESTE d'une mission : "
    + "nature et dossier canoniques, dates (donne-les si tu les as lues ; sinon elles sont lues sur la pièce), partie résolue à l'annuaire, "
    + "entité. Un dossier entier du Drive : `dossierDrive`. Le fichier reste dans le Drive. N'invente aucune date : laisse vide ce que tu n'as pas lu. "
    + "Plus de 30 pièces : une mission par paquets.",
  schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "Les pièces à ranger (une entrée par fichier).",
        items: {
          type: "object",
          properties: {
            fichier: { type: "string", description: "Nom ou identifiant Drive du fichier." },
            nature: { type: "string", description: "contrat, avenant, statuts, PV, agrément, AMM, licence, assurance, bail, convention, NDA, devis, attestation…" },
            titre: { type: "string", description: "Le titre exact tel qu'il figure sur la pièce." },
            partie: { type: "string", description: "L'autre partie (cocontractant, organisme délivrant) — nom de l'annuaire." },
            debut: { type: "string", description: "Date de début / d'effet AAAA-MM-JJ (lue sur la pièce)." },
            fin: { type: "string", description: "Échéance / date de fin AAAA-MM-JJ (lue sur la pièce)." },
            montant: { type: "string", description: "Montant en DZD, si la pièce en porte un." },
            reference: { type: "string" },
            dossier: { type: "string", description: "Dossier de classement voulu (sinon celui de la nature)." },
            notes: { type: "string" },
          },
          required: ["fichier"],
        },
      },
      dossierDrive: { type: "string", description: "Un DOSSIER du Drive dont toutes les pièces (≤ 30) sont à ranger d'un coup — en UNE carte." },
      dossier: { type: "string", description: "Un dossier de classement Juridique commun à toutes les pièces (facultatif)." },
      entite: { type: "string", description: "La société du groupe concernée (facultatif, sinon celle de la personne)." },
      lecteurs: { type: "string", description: "Restreindre la lecture à ces collègues (noms, séparés par des virgules) — facultatif." },
    },
  },
  ouverte,
  proposer: proposerRangement,
  executer: executerRangement,
};

// ───────────────────────────── Mettre à jour une fiche juridique ─────────────────────────────

interface FicheLue {
  id: string; title: string; driveNodeId: string | null; kind: string; reference: string | null; counterpartyIds: string[]; startDate: Date | null; endDate: Date | null;
  notes: string | null; amount: unknown; folderId: string | null; chainFromId: string | null; direction: string | null; paidDate: Date | null;
}

/** Une fiche du registre que la personne LIT et peut MODIFIER — jamais nommée si elle ne la lit pas (§118.71). */
export async function ficheJuridique(user: CurrentUser, ref: string): Promise<{ fiche: FicheLue } | { erreur: string }> {
  const q = ref.trim();
  if (!q) return { erreur: "Nommez la pièce juridique (titre, référence ou partie)." };
  // Les MOTS se comparent sans accents (« siege » trouve « siège ») : Postgres ne replie pas les accents, le code le fait.
  const mots = replierTexte(q).split(/[^a-z0-9]+/).filter((m) => m.length >= 3 && !MOTS_VIDES.has(m)).slice(0, 6);
  const lisibles = await piecesJuridiquesLisibles(user, { status: { not: "CANCELLED" } }, 1500);
  const visibles = lisibles.filter((r) => r.id === q || (r.reference ?? "").toLowerCase() === q.toLowerCase()
    || (mots.length > 0 && mots.every((m) => replierTexte(`${r.title} ${r.counterparty ?? ""} ${r.reference ?? ""}`).includes(m)))).slice(0, 8);
  if (!visibles.length) return { erreur: `Aucune pièce juridique « ${q} » parmi celles que vous pouvez ouvrir.` };
  const exacte = visibles.filter((r) => replierTexte(r.title) === replierTexte(q) || (r.reference ?? "").toLowerCase() === q.toLowerCase());
  const choix = exacte.length === 1 ? exacte : visibles;
  if (choix.length > 1) return { erreur: `${choix.length} pièces correspondent : ${choix.slice(0, 5).map((r) => `« ${r.title} »`).join(", ")}. Laquelle ?` };
  return { fiche: choix[0]! as FicheLue };
}

const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export const MODIFIER_FICHE_JURIDIQUE: OperationIA = {
  nom: "modifier_fiche_juridique",
  module: "LEGAL",
  libelle: "Mise à jour juridique préparée",
  description:
    "MET À JOUR une fiche du registre juridique que tu vois : échéance, date de début, titre, référence, montant, notes, dossier de classement. "
    + "Seuls les champs donnés changent ; les autres gardent leur valeur. Par l'action de l'écran (droits revérifiés), annulable.",
  schema: {
    type: "object",
    properties: {
      piece: { type: "string", description: "Titre, référence ou partie de la pièce." },
      titre: { type: "string" }, debut: { type: "string", description: "AAAA-MM-JJ" }, fin: { type: "string", description: "Nouvelle échéance AAAA-MM-JJ" },
      montant: { type: "string" }, reference: { type: "string" }, notes: { type: "string", description: "Remplace les notes (ajoute « + » devant pour compléter)." },
      dossier: { type: "string", description: "Nouveau dossier de classement." },
    },
    required: ["piece"],
  },
  ouverte: (u) => userCan(u, "LEGAL", "UPDATE"),
  async proposer(e, user): Promise<PropositionOperation> {
    const r = await ficheJuridique(user, texte(e, "piece"));
    if ("erreur" in r) return { erreur: r.erreur };
    const f = r.fiche;
    const peut = (await piecesJuridiquesModifiables(user, [f.id])).has(f.id);
    if (!peut) return { erreur: `« ${f.title} » : vous pouvez la lire, pas la modifier.` };
    const debut = texte(e, "debut") ? dateJuridique(texte(e, "debut")) : jour(f.startDate);
    const fin = texte(e, "fin") ? dateJuridique(texte(e, "fin")) : jour(f.endDate);
    if (texte(e, "debut") && !debut) return { erreur: `Date de début illisible : « ${texte(e, "debut")} ».` };
    if (texte(e, "fin") && !fin) return { erreur: `Échéance illisible : « ${texte(e, "fin")} ».` };
    if (debut && fin && fin < debut) return { erreur: `L'échéance (${fin}) précède le début (${debut}).` };
    const montant = texte(e, "montant") ? montantJuridique(texte(e, "montant")) : (f.amount == null ? null : Number(f.amount));
    const notesDemandees = texte(e, "notes");
    const notes = !notesDemandees ? f.notes : notesDemandees.startsWith("+") ? [f.notes, notesDemandees.slice(1).trim()].filter(Boolean).join("\n") : notesDemandees;
    const dossierNom = texte(e, "dossier");
    const dossierId = dossierNom ? await dossierExistant(user, dossierNom) : f.folderId;
    if (dossierNom && !dossierId) return { erreur: `Le dossier « ${dossierNom} » n'existe pas au Juridique (ranger_au_juridique le crée en rangeant).` };
    const changes: [string, string | null][] = [];
    const titre = texte(e, "titre") || f.title;
    if (titre !== f.title) changes.push(["Titre", `${f.title} → ${titre}`]);
    if (debut !== jour(f.startDate)) changes.push(["Début", `${jour(f.startDate) ?? "—"} → ${debut ?? "—"}`]);
    if (fin !== jour(f.endDate)) changes.push(["Échéance", `${jour(f.endDate) ?? "sans"} → ${fin ?? "sans"}`]);
    if (texte(e, "montant") && montant !== (f.amount == null ? null : Number(f.amount))) changes.push(["Montant", montant == null ? "—" : dzd(montant)]);
    if (texte(e, "reference") && texte(e, "reference") !== f.reference) changes.push(["Référence", texte(e, "reference")]);
    if (notes !== f.notes) changes.push(["Notes", (notes ?? "").slice(0, 200)]);
    if (dossierId !== f.folderId) changes.push(["Dossier", dossierNom]);
    if (!changes.length) return { erreur: `« ${f.title} » : rien à changer (les valeurs demandées sont déjà celles de la fiche).` };
    return {
      carte: { title: `Mettre à jour — ${f.title}`, fields: champs([["Pièce", f.title], ...changes]), warnings: ["Les autres champs de la fiche gardent leur valeur. « Annule » remet les valeurs d'avant."], libelleBouton: "Mettre à jour la fiche" },
      args: {
        id: f.id, title: titre, kind: f.kind, counterpartyIds: JSON.stringify(f.counterpartyIds), startDate: debut, endDate: fin,
        amount: montant == null ? null : String(montant), reference: texte(e, "reference") || f.reference, notes, folderId: dossierId,
        chainFromId: f.chainFromId, direction: f.direction, paidDate: jour(f.paidDate),
      },
    };
  },
  async executer(a) {
    const ids = JSON.parse(a.counterpartyIds ?? "[]") as string[];
    const r = await updateLegalDocument(fd({
      id: a.id, title: a.title, kind: a.kind, counterpartyIds: ids, startDate: a.startDate, endDate: a.endDate, amount: a.amount, reference: a.reference,
      notes: a.notes, folderId: a.folderId, chainFromId: a.chainFromId, direction: a.direction, paidDate: a.paidDate,
    }));
    return r.ok ? { ok: true, message: `Fiche « ${a.title} » mise à jour.`, link: `/legal/${a.id}`, revalidate: ["/legal"] } : { ok: false, error: r.error ?? "Mise à jour refusée." };
  },
};
