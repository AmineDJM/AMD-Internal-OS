import type { ContratAction, ChampAction } from "./contrat";
import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHEMIN GÉNÉRIQUE — ET CE QU'IL NE FRANCHIRA JAMAIS.
 *
 * `contrat.ts` rend 598 actions descriptibles sans une fiche écrite à la main. Ce module est
 * ce qui décide LESQUELLES un modèle peut déclencher, et avec quelles entrées.
 *
 * ── LE DANGER QUE LA MESURE A RÉVÉLÉ ─────────────────────────────────────────────────────
 *
 * En comparant la dérivation aux 520 ops déclarées à la main, 118 actions sont apparues
 * atteignables SEULEMENT par le chemin générique. L'échantillon commence ainsi :
 * `updateUserRole`, `setSecondaryRole`, `setRowGrants`, `setUserActive`, `superAdminDelete`,
 * `revokeSession`. Ce ne sont pas des trous de couverture : ce sont EXACTEMENT les gestes que
 * §118.6 interdit structurellement à l'agent. Le « gain » du chemin générique était, en tête
 * de liste, l'auto-escalade.
 *
 * ── POURQUOI PAS `policy/guard.ts` TEL QUEL ──────────────────────────────────────────────
 *
 * Il existe et il a raison, mais il reconnaît les capacités à leur NOM, avec des motifs écrits
 * pour des identifiants en serpent (`update_rule`, `create_user`). Passés sur des noms d'action
 * en camel, ils LAISSENT PASSER `updateUserRole` : aucun de `\brole\b`, `_role`, `role_` ne
 * s'accroche au milieu d'un mot. Une garde qui ne s'arme pas sur la convention qu'on lui donne
 * est une garde désarmée qui a l'air armée — le pire des deux (§118.17). On ne l'élargit pas
 * non plus : ses motifs servent des capacités de mission, et les élargir ferait refuser là-bas.
 *
 * ── SUR QUOI CELLE-CI S'ARME ─────────────────────────────────────────────────────────────
 *
 * Sur le MODÈLE ÉCRIT, lu dans la source (`prisma.user.update`). Un modèle ne se renomme pas
 * pour échapper à une garde, et une action ajoutée demain qui touche `UserAccess` est refusée
 * sans que personne ait pensé à elle. Le nom reste un FILET SECONDAIRE, pour les actions dont
 * on n'a pas su lire les écritures.
 *
 * La liste des modèles est fermée et EXHAUSTIVE au regard du schéma : le test exige que tout
 * modèle du schéma dont le nom porte identité, droit, session, invitation ou réglage soit
 * ICI — refusé — ou dans la liste des exceptions AVEC sa raison. Un modèle de droits ajouté
 * demain fait échouer le test au lieu d'ouvrir une porte en silence.
 *
 * ── ET CE QUE LE REFUS NE VEUT PAS DIRE ──────────────────────────────────────────────────
 *
 * Refusé À L'AGENT n'est pas « impossible ». Ces gestes vivent dans les écrans d'administration
 * et une personne les fait en trois clics. Le refus le DIT (§118.30 : nommer le remède), sans
 * quoi Adam répondrait « je ne peux pas » là où la bonne phrase est « c'est à vous de le faire,
 * ici ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES MODÈLES QU'ÉCRIRE EST UNE AUTO-ESCALADE.
 *
 * Chaque entrée porte le geste qu'elle protège, parce que c'est ce texte qu'un humain lira.
 */
export const MODELES_INTERDITS: Readonly<Record<string, string>> = {
  user: "le compte, le rôle ou le mot de passe d'une personne",
  userAccess: "les droits de module d'une personne",
  rowGrant: "les accès ligne à ligne d'une personne",
  userSession: "les sessions ouvertes d'une personne",
  userInvite: "les invitations à créer un compte",
  userCompanyAccess: "le rattachement d'une personne à une société",
  userProductRange: "la gamme de produits qu'une personne peut voir",
  departmentBudgetAccess: "l'accès d'une personne au budget d'un département",
  medicalDirectoryAccess: "l'accès d'une personne à l'annuaire médical",
  regulatoryFeatureAccess: "l'accès d'une personne aux fonctions Regulatory",
  supplierUser: "les comptes fournisseurs",
  // Les RÉGLAGES portent les garde-fous eux-mêmes — la politique d'envoi d'Adam, la pause
  // sortante, les bascules de fonctionnalité. Le chemin générique ne sait pas distinguer un
  // réglage qui RESTREINT d'un réglage qui OUVRE ; il refuse donc les deux, et les gestes
  // légitimes gardent leurs ops déclarées (§118.15 : ce qui réduit reste disponible là).
  appSetting: "les réglages de l'application, dont les garde-fous d'Adam",
  aiSetting: "les réglages des modèles",
  featureFlag: "les bascules de fonctionnalité",
  riskSetting: "les seuils de risque",
  adoptionSetting: "les réglages d'adoption",
  sfeSettings: "les réglages SFE",
  kpiReviewSetting: "la fréquence de revue des KPI d'une équipe — un réglage que le manager choisit lui-même",
  assistantRule: "les règles enseignées à Adam — une règle est l'attestation d'une PERSONNE",
  // LA CONFIGURATION DE L'ASSISTANT PAR RÔLE — ses consignes et la liste d'outils qu'il offre à un
  // rôle : un garde-fou au même titre que `aiSetting`, réservé au Super Admin. Son audit est la
  // trace de qui l'a changée ; le réécrire effacerait la preuve.
  assistantRoleConfig: "la configuration de l'assistant par rôle (consignes, outils autorisés)",
  assistantRoleConfigAudit: "l'historique des modifications de la configuration de l'assistant",
  // LA CLÉ DE LIAISON AU SITE PUBLIC (§118.159) — l'identifiant qui donne le droit d'y publier.
  // Refusée sur le MODÈLE écrit, en plus de la décision EXCLUDED : une action ajoutée demain qui
  // l'écrirait, sous un autre nom, dans un autre fichier, l'est sans que personne y pense.
  siteWebCle: "la clé de liaison au site public — l'identifiant qui donne le droit d'y publier",
  // LE COFFRE DES DONNÉES SENSIBLES (refonte P1, R6) — NIN, passeport, RIB, salaire, chiffrés, et le
  // journal de qui les a lus. L'assistant et les modèles n'y ont jamais accès ; réécrire le journal
  // effacerait la preuve d'une lecture.
  donneeSensible: "le coffre des données sensibles (NIN, passeport, RIB, salaire)",
  accesDonneeSensible: "le journal des lectures du coffre des données sensibles",
};

/**
 * LES MODÈLES QUE LE NOM DÉSIGNE MAIS QUI NE SONT PAS DES DROITS — et pourquoi.
 *
 * Sans cette liste, l'exhaustivité exigerait de refuser des gestes métier ordinaires, et un
 * refus à tort coûte plus cher que le défaut qu'on corrige (§118.27).
 */
export const MODELES_NON_SENSIBLES: Readonly<Record<string, string>> = {
  ArtifactSession: "une session d'édition de document — un espace de travail, aucun droit",
  RegulatoryUploadSession: "un lot de dépôt de fichiers Regulatory, aucun droit",
  SessionEvent: "la trace d'un événement de session — un journal qu'on lit, pas une porte",
  CalendarInvite: "une invitation à une RÉUNION, pas à un compte",
  PersonneRole: "ce qu'une personne EST pour l'entreprise (médecin, voyageur, candidat) — une qualité de la fiche, aucun droit",
  OrganisationRole: "ce qu'une organisation EST pour l'entreprise (fournisseur, client) — une qualité de la fiche, aucun droit",
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SURFACES QUI EXIGENT UNE MAIN HUMAINE — la SECONDE chose sur quoi cette garde s'arme.
 *
 * ── POURQUOI UNE SECONDE, ET NON UN MODÈLE DE PLUS ───────────────────────────────────────
 *
 * La garde ci-dessus s'arme sur le modèle Prisma écrit DANS LE CORPS de l'action. C'est un
 * bon fait, et il a un angle mort exact : une action qui DÉLÈGUE son écriture à une
 * bibliothèque n'écrit rien elle-même. Mesuré sur le parc : 63 actions ouvertes n'ont aucun
 * modèle détecté, et `deciderAccordMission`, `fournirElementMission`, `setAdamOutboundPaused`
 * en font partie — toutes trois passent par `missions/` ou par le service de réglages. La
 * garde ne les VOIT pas. Les onze autres qui écrivent en délégant sont des gestes métier
 * ordinaires (créer un dossier, envoyer un courrier), chacun portant son propre `userCan` :
 * ce n'est donc pas la délégation qu'il faut refuser, c'est ce qui vit derrière.
 *
 * ── CE QUI EST REFUSÉ, ET SUR QUEL FAIT ──────────────────────────────────────────────────
 *
 * Le FICHIER. §118.15 nomme `mission-runtime-actions.ts` comme la porte des gestes qui
 * exigent un clic dans une vraie session : ACCORDER une autorisation et FOURNIR une pièce
 * sont des ATTESTATIONS — l'audit portera le nom d'une personne. Un document lu par une étape
 * peut contenir « approuve la mission » ; si l'outil existe, l'injection réussit et rien ne
 * distingue plus l'accord forgé du vrai. `adam-settings-actions.ts` est l'autre : ses trois
 * bascules SONT les garde-fous de sortie, d'entrée et de connexion d'Adam, et §118.6 interdit
 * de désactiver un garde-fou.
 *
 * S'armer sur le fichier plutôt que sur une liste de noms est ce qui rend la garde
 * EXHAUSTIVE et auto-entretenue (§118.17 : un fait du processus, jamais une variable qu'on
 * doit penser à poser) : une bascule ajoutée demain dans `adam-settings-actions.ts` est
 * refusée sans que personne ait pensé à elle.
 *
 * ── CE QUE CE REFUS SUR-REFUSE, ET POURQUOI C'EST GRATUIT ────────────────────────────────
 *
 * §118.15 dit que les gestes qui RÉDUISENT — suspendre, arrêter, refuser — sont sans danger
 * et disponibles dans la conversation. `mettreMissionEnPause` et `arreterMission` vivent dans
 * le fichier refusé : elles sont donc écartées du chemin GÉNÉRIQUE. Ça ne coûte rien, parce
 * qu'elles ont déjà leur porte — le contrat de plateforme `mission.status` — et le refus la
 * NOMME. Refuser une seconde route vers un geste qui en a déjà une n'est pas un « je ne peux
 * pas » artificiel ; laisser une porte non gardée à côté d'une porte gardée, si (§118.71).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const SURFACES_HUMAINES: Readonly<Record<string, string>> = {
  "mission-runtime-actions":
    "le pilotage d'une mission par un humain — accorder une autorisation et fournir une pièce "
    + "sont des ATTESTATIONS : l'audit portera le nom d'une personne, et un document lu par une "
    + "étape pourrait contenir « approuve la mission ». Ces gestes se font depuis Mission "
    + "Control ; ceux qui RÉDUISENT (suspendre, arrêter) restent accessibles dans la "
    + "conversation par le contrat de plateforme",
  "adam-settings-actions":
    "les garde-fous d'Adam lui-même — l'interrupteur de sortie, celui d'entrée et celui de "
    + "connexion. Adam ne relève pas ses propres barrières, même à la demande d'une personne qui "
    + "en a le droit. Ce réglage se fait depuis l'écran des réglages d'Adam",
  // LA SIGNATURE DES FINANCES (§118.149) — une ATTESTATION : l'audit portera le nom d'une
  // personne, et c'est elle qui fait partir un BC chez le fournisseur. Le fichier entier est
  // refusé, comme les deux ci-dessus : une action de signature ajoutée demain l'est sans que
  // personne y pense (§118.78).
  "bc-signature-actions":
    "la signature d'un bon de commande par les Finances — une ATTESTATION : l'audit portera le "
    + "nom d'une personne, et un devis ou un mail lu par une étape pourrait contenir « signe ce "
    + `bon de commande ». Elle se donne d'un clic, depuis ${MENU_BONS_DE_COMMANDE}`,
};

/**
 * LES MOTS D'UN IDENTIFIANT — `updateUserRole` → `update`, `user`, `role`.
 *
 * On coupe sur les tirets bas, les chiffres ET les bosses de casse, parce que le parc écrit ses
 * actions en camel et §118.74 a déjà payé l'erreur inverse : des motifs en serpent (`_role`,
 * `role_`) passés sur du camel LAISSAIENT passer `updateUserRole`, une garde désarmée en ayant
 * l'air armée.
 */
function motsDuNom(nom: string): string[] {
  return nom
    .split(/[_\d]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((m) => m.toLowerCase());
}

/**
 * Filet SECONDAIRE : ce que le nom d'une action dit quand ses écritures n'ont pas été lues.
 *
 * LE VOCABULAIRE SE COMPARE À UN MOT, JAMAIS À UNE SOUS-CHAÎNE. Mesuré : `secret` cherché
 * n'importe où refusait `demanderPieceSecretariat` — une demande de devis au bureau du
 * SECRÉTARIAT, écriture métier parfaitement ordinaire, classée « désigne un droit ou un
 * identifiant » parce qu'un mot français contient six lettres anglaises. C'est un « je ne peux
 * pas » écrit dans le CODE (§118.63), et un refus à tort coûte plus cher que le défaut qu'il
 * prétend éviter (§118.27).
 *
 * Mesure du remède sur le parc entier : **22 actions refusées par la sous-chaîne, 21 par le
 * mot — et l'écart est exactement le faux positif**, aucune vraie prise perdue. La règle reste
 * un FILET : ce qui touche vraiment aux droits est attrapé plus haut, sur le MODÈLE ÉCRIT lu
 * dans la source (§118.74), qui ne dépend d'aucune façon de nommer.
 *
 * Les inflexions sont admises (`grants`, `roleId`, `tokens`) : un pluriel ou un suffixe
 * d'identifiant nomme la même chose, et les exclure rouvrirait `setRowGrants`.
 */
const MOTIFS_NOM = [
  { mots: ["role", "permission", "grant", "access", "rbac", "password", "credential", "token", "secret"], raison: "un droit ou un identifiant" },
  { mots: ["superadmin"], raison: "un pouvoir de Super Admin" },
  { mots: ["featureflag", "killswitch", "guard", "bypass"], raison: "un garde-fou" },
];

/**
 * Le mot du vocabulaire porté par ce nom, ou `null` — jamais une ressemblance partielle.
 *
 * ON COMPARE AUSSI LES PAIRES ADJACENTES, et c'est ce qui manquait à la première version :
 * `superAdminDelete` se coupe en `super` + `admin` + `delete`, donc aucun mot seul ne vaut
 * `superadmin` — la garde que §118.74 nomme en premier laissait passer l'action qu'elle est
 * écrite pour attraper. Trouvé en MESURANT par la vraie fonction, pas par relecture : ma
 * première mesure ne passait qu'UN des trois vocabulaires et concluait sur la règle entière
 * (§118.92 — la question n'est pas « est-ce cassé ? » mais « qu'est-ce que la sonde a
 * réellement mesuré ? »). Les composés du vocabulaire — `superadmin`, `featureflag`,
 * `killswitch` — s'écrivent tous en deux mots dans le parc.
 */
function motInterdit(nom: string, vocabulaire: readonly string[]): string | null {
  const mots = motsDuNom(nom);
  const paires = mots.slice(0, -1).map((m, i) => m + mots[i + 1]!);
  for (const mot of [...mots, ...paires]) {
    for (const v of vocabulaire) {
      if (mot === v) return v;
      // Inflexions : pluriel, participe, suffixe d'identifiant. `secretariat` n'en est pas une.
      const reste = mot.startsWith(v) ? mot.slice(v.length) : null;
      if (reste !== null && ["s", "es", "ed", "id", "ids"].includes(reste)) return v;
    }
  }
  return null;
}

/**
 * CE CONTRAT EST-IL HORS DU CHEMIN GÉNÉRIQUE ? Rend `null` quand il est permis, sinon la
 * raison — jamais un booléen : un refus sans motif ne peut ni être compris, ni corrigé.
 */
export function interdictionGenerique(c: ContratAction): string | null {
  // LE FICHIER D'ABORD : c'est le seul fait qui voit une action déléguant son écriture, donc
  // le seul qui attrape les attestations humaines et les garde-fous d'Adam (voir plus haut).
  const surface = SURFACES_HUMAINES[c.fichier];
  if (surface) {
    return `Cette action appartient à ${surface}. C'est un refus de conception, pas une limite `
      + `technique : le chemin générique ne s'y substitue pas.`;
  }
  for (const modele of c.modelesEcrits) {
    const quoi = MODELES_INTERDITS[modele];
    if (quoi) {
      return `Cette action modifie ${quoi}. Adam ne touche jamais aux droits ni aux garde-fous, `
        + `même à la demande d'une personne qui en a le droit — c'est un refus de conception, pas `
        + `une limite technique. Ce geste se fait depuis l'écran d'administration.`;
    }
  }
  for (const m of MOTIFS_NOM) {
    if (motInterdit(c.fonction, m.mots)) {
      return `Le nom de cette action désigne ${m.raison}, et le chemin générique n'y touche pas. `
        + `Ce geste se fait depuis l'écran d'administration.`;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// LA VALIDATION D'UNE ENTRÉE CONTRE SON CONTRAT
// ───────────────────────────────────────────────────────────────────────────────────────────

export interface EntreeRefusee {
  /** Ce qui ne va pas, en une phrase adressée à qui va corriger — modèle ou humain. */
  raison: string;
  /** Le champ en cause, quand il y en a un. */
  champ?: string;
}

/**
 * L'ENTRÉE PROPOSÉE TIENT-ELLE DANS LE CONTRAT ?
 *
 * Trois refus, et chacun existe parce que l'accepter produirait un faux succès plutôt qu'une
 * erreur : un champ INCONNU serait ignoré par l'action (« c'est fait » sans effet) ; un champ
 * OBLIGATOIRE manquant ferait échouer l'action pour une raison qu'on savait d'avance ; une
 * valeur HORS de l'énum déclaré serait refusée plus loin, après un aller-retour inutile.
 *
 * Ce qu'on ne refuse PAS : une valeur dont les valeurs admises n'ont pas été lues (`null`).
 * Une garde qui refuse ce qu'elle ne comprend pas est désactivée dans la semaine (§118.16).
 */
export function validerEntree(
  c: ContratAction,
  entree: Readonly<Record<string, unknown>>,
): EntreeRefusee[] {
  if (c.illisible) {
    return [{ raison: `Cette action ne s'appelle pas par le chemin générique : ${c.illisible}.` }];
  }
  const refus: EntreeRefusee[] = [];
  const connus = new Map<string, ChampAction>(c.champs.map((ch) => [ch.nom, ch]));

  for (const nom of Object.keys(entree)) {
    if (!connus.has(nom)) {
      refus.push({
        champ: nom,
        raison: `« ${nom} » n'est pas une entrée de cette action. Elle attend : `
          + `${c.champs.map((x) => x.nom).join(", ")}.`,
      });
    }
  }
  for (const ch of c.champs) {
    const v = entree[ch.nom];
    const absent = v === undefined || v === null || v === "";
    if (ch.obligatoire && absent) {
      refus.push({ champ: ch.nom, raison: `« ${ch.nom} » est obligatoire pour cette action.` });
      continue;
    }
    if (absent || !ch.valeurs) continue;
    const valeurs = Array.isArray(v) ? v : [v];
    for (const une of valeurs) {
      if (!ch.valeurs.includes(String(une))) {
        refus.push({
          champ: ch.nom,
          raison: `« ${String(une)} » n'est pas une valeur admise pour « ${ch.nom} » : `
            + `${ch.valeurs.join(", ")}.`,
        });
      }
    }
  }
  return refus;
}

/**
 * L'ENTRÉE, TRADUITE EN FORMULAIRE — la forme que 619 des 715 actions attendent.
 *
 * Une valeur `undefined` ou `null` n'est PAS écrite : un champ absent et un champ vide ne
 * disent pas la même chose à une action qui distingue « ne touche pas » de « efface » (§118.71,
 * où une clé effacée par `JSON.stringify` avait fait refuser un destinataire qu'on tenait).
 * Une LISTE devient plusieurs entrées du même nom, ce que `getAll` relit exactement.
 */
/**
 * L'ENTRÉE, TRADUITE EN ARGUMENTS POSITIONNELS — pour les 40 actions à entrée typée.
 *
 * L'ORDRE vient du CONTRAT, qui le tient de la signature : c'est la seule source qui le
 * connaisse. Un champ absent devient `undefined` à son rang — jamais omis, sinon tous les
 * suivants glissent d'une place et `renameDocument(id, name)` renommerait avec l'identifiant.
 *
 * Et les valeurs sont de VRAIS types, pas des chaînes : `enFormulaire` écrit « on » pour un
 * booléen parce qu'un formulaire n'a que du texte, mais une fonction qui déclare
 * `paused: boolean` recevrait `"on"` — une chaîne non vide, donc VRAIE, y compris quand la
 * demande dit « non ». Le faux succès parfait, pour une conversion.
 */
export function enArguments(
  c: ContratAction,
  entree: Readonly<Record<string, unknown>>,
): unknown[] {
  return c.champs.map((ch) => {
    const v = entree[ch.nom];
    if (v === undefined || v === null || v === "") return undefined;
    if (ch.type === "booleen") {
      return typeof v === "boolean" ? v : ["true", "1", "on", "oui", "vrai"].includes(String(v).toLowerCase());
    }
    if (ch.type === "nombre") return typeof v === "number" ? v : Number(String(v).replace(",", "."));
    if (ch.type === "liste") return (Array.isArray(v) ? v : [v]).map(String);
    if (ch.type === "date") return v instanceof Date ? v : new Date(String(v));
    return String(v);
  });
}

/**
 * L'ENTRÉE, TRADUITE EN UN OBJET UNIQUE — pour les 13 actions dont la signature ÉNONCE ses
 * membres (`setInvoicePaid(input: { id: string; paidDate: string | null })`).
 *
 * Un membre absent est OMIS, jamais posé à `undefined` : un objet n'a pas de rangs, donc rien
 * ne glisse, et une clé absente laisse la valeur par défaut de l'action là où une clé posée à
 * `undefined` écraserait (§118.71 — une clé absente et une clé vide ne disent pas la même
 * chose). C'est la différence exacte avec `enArguments`, où le rang DOIT être occupé.
 */
export function enObjet(
  c: ContratAction,
  entree: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ch of c.champs) {
    const v = entree[ch.nom];
    if (v === undefined || v === null || v === "") continue;
    if (ch.type === "booleen") out[ch.nom] = typeof v === "boolean" ? v : ["true", "1", "on", "oui", "vrai"].includes(String(v).toLowerCase());
    else if (ch.type === "nombre") out[ch.nom] = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    else if (ch.type === "liste") out[ch.nom] = (Array.isArray(v) ? v : [v]).map(String);
    else if (ch.type === "date") out[ch.nom] = v instanceof Date ? v : new Date(String(v));
    else out[ch.nom] = String(v);
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA LISTE D'ARGUMENTS D'UN APPEL — décidée à UN SEUL endroit.
 *
 * La version précédente était une cascade de ternaires dans l'exécuteur, avec un DERNIER CAS
 * qui appelait `fn(formData)`. Ajouter une forme d'appel sans y penser faisait donc tomber
 * cette forme dans le cas par défaut : le formulaire arrivait au rang 0 d'une fonction qui
 * attend un identifiant, et l'action lisait un état là où on lui donne des données — sans
 * erreur, sans effet, avec un `{ ok: … }` à l'air normal (§118.14 sur une porte de sortie que
 * personne ne garde, §118.70).
 *
 * Ici la forme est EXHAUSTIVE au sens du compilateur : le `satisfies never` final refuse de
 * compiler si l'on ajoute une forme d'appel sans dire comment on l'appelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function argumentsDAppel(
  c: ContratAction,
  entree: Readonly<Record<string, unknown>>,
): unknown[] {
  switch (c.appel) {
    case "sans-entree": return [];
    case "objet": return [enObjet(c, entree)];
    case "arguments": return enArguments(c, entree);
    case "formulaire": return [enFormulaire(entree)];
    // `useActionState` : l'état précédent AVANT le formulaire. `undefined` est exactement ce
    // qu'un premier envoi lui donne.
    case "etat-formulaire": return [undefined, enFormulaire(entree)];
    case "arguments-etat-formulaire": {
      // Les `avantFormulaire` premiers champs sont POSITIONNELS ; le reste est le formulaire,
      // duquel on retire les noms déjà passés en argument — une même valeur ne remplit pas
      // deux places, et le contrat refuse déjà cette collision.
      const avant = { ...c, champs: c.champs.slice(0, c.avantFormulaire) };
      const noms = new Set(avant.champs.map((ch) => ch.nom));
      const reste = Object.fromEntries(Object.entries(entree).filter(([k]) => !noms.has(k)));
      return [...enArguments(avant, entree), undefined, enFormulaire(reste)];
    }
    default: {
      const jamais: never = c.appel;
      throw new Error(`Forme d'appel non gérée : ${String(jamais)}`);
    }
  }
}

export function enFormulaire(entree: Readonly<Record<string, unknown>>): FormData {
  const fd = new FormData();
  for (const [cle, v] of Object.entries(entree)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const une of v) fd.append(cle, String(une));
    else if (v instanceof Date) fd.append(cle, v.toISOString());
    else fd.append(cle, typeof v === "boolean" ? (v ? "on" : "") : String(v));
  }
  return fd;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// LA DÉCOUVERTE
// ───────────────────────────────────────────────────────────────────────────────────────────

const MOTS_VIDES = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "et", "ou", "a", "à", "au", "aux",
  "en", "dans", "pour", "par", "sur", "avec", "ce", "cet", "cette", "ces", "que", "qui", "quoi",
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "me", "moi", "te", "toi", "se", "son",
  "sa", "ses", "mon", "ma", "mes", "est", "sont", "peux", "peut", "veux", "veut", "fais", "fait",
  "faire", "stp", "svp", "merci", "the", "of", "to",
]);

/** Les mots utiles d'une phrase — accents repliés, mots vides retirés, deux lettres minimum. */
export function motsUtiles(texte: string): string[] {
  return texte
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length >= 3 && !MOTS_VIDES.has(m));
}

/** Les mots qu'un identifiant d'action porte : `bd-project-actions:createBdProject`. */
function motsDuContrat(c: ContratAction): string[] {
  return motsUtiles(
    `${c.fichier.replace(/-actions$/, "")} ${c.fonction.replace(/([a-z0-9])([A-Z])/g, "$1 $2")} `
    + `${c.porte.module ?? ""} ${c.porte.moduleFr ?? ""} ${c.champs.map((x) => x.nom).join(" ")}`,
  );
}

export interface CapaciteTrouvee {
  contrat: ContratAction;
  score: number;
  /** `null` si elle est ouverte au chemin générique, sinon pourquoi elle ne l'est pas. */
  interdiction: string | null;
}

/**
 * CHERCHER UNE CAPACITÉ — un tri par recouvrement de mots, pas une promesse de pertinence.
 *
 * Les interdites SONT rendues, avec leur motif. Les taire ferait répondre « je ne trouve rien »
 * là où la vérité est « je l'ai trouvée et je n'y touche pas » — un « je ne peux pas »
 * artificiel, et le défaut que ce dépôt a déjà payé deux fois (§118.59, §118.63).
 */
export function chercherCapacites(
  contrats: readonly ContratAction[],
  intention: string,
  limite = 8,
): CapaciteTrouvee[] {
  const mots = motsUtiles(intention);
  if (mots.length === 0) return [];
  const trouve: CapaciteTrouvee[] = [];
  for (const c of contrats) {
    const cible = motsDuContrat(c);
    let score = 0;
    for (const m of mots) {
      if (cible.includes(m)) score += 2;
      else if (cible.some((x) => x.startsWith(m) || m.startsWith(x))) score += 1;
    }
    if (score > 0) trouve.push({ contrat: c, score, interdiction: interdictionGenerique(c) });
  }
  return trouve
    .sort((a, b) => b.score - a.score || a.contrat.id.localeCompare(b.contrat.id))
    .slice(0, limite);
}
