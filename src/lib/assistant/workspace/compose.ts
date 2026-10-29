import {
  WORKSPACE_LIMITS,
  type WorkspaceBlock, type WorkspaceComposition, type WorkspaceDoc,
  type WorkspaceEvent, type WorkspaceField, type WorkspaceGauge,
  type WorkspaceColumn, type WorkspaceEndpoint, type WorkspaceItem, type WorkspaceMail,
  type WorkspacePerson, type WorkspaceRow, type WorkspaceStep,
} from "@/platform/ia/workspace/protocol";
import {
  actionsOf, arr, clip, DOC_KINDS, endpointsOf, humanize, isInternalHref, isObj, num, readColumns,
  readEditable, readPerson, readRows, readSheet, s, strings, TONES, tonOf, type Json,
} from "@/platform/ia/workspace/read";
import { suivreChemin } from "@/lib/skills/affichage";
import { readGodmodeBlock } from "./compose-godmode";
import { readDashboardBlock, readVizBlock } from "@/platform/ia/workspace/viz-block";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DE LA SOURCE CANONIQUE À L'ÉCRAN — une traduction, pas une génération.
 *
 * Le modèle n'intervient nulle part ici. On lit la sortie EXACTE d'un outil canonique et on la
 * range dans les blocs typés du protocole. Ce qui s'affiche vient donc de la base de données.
 *
 * ── LA RÈGLE DE SÛRETÉ, QUI EST AUSSI LA RÈGLE DE QUALITÉ ─────────────────────────────────
 *
 * UNE FORME NON RECONNUE NE PRODUIT RIEN (`null`). Pas de bloc « données brutes », pas de
 * repli en JSON indenté. C'est exactement le chemin par lequel six lignes de salaire sont
 * arrivées à l'écran en réponse à « Bonsoir, ça va ? » : un affichage capable de tout montrer
 * finit par tout montrer. Ici, l'inconnu ne s'affiche pas — la réponse en texte suffit.
 *
 * Les fonctions sont PURES et défensives : la sortie d'un outil est du JSON qu'on n'a pas
 * écrit dans ce fichier, donc chaque champ est vérifié avant d'être lu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */



function parse(raw: string): Json | unknown[] | null {
  const t = raw.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) || Array.isArray(v) ? (v as Json | unknown[]) : null;
  } catch {
    // Une sortie tronquée n'est pas une donnée : on ne devine pas ce qui manque.
    return null;
  }
}

/**
 * Un outil qui répond « rien trouvé » rend un objet `{ resultat, precision }`. Ce n'est pas un
 * échec de composition : c'est une réponse, et elle se dit en texte, pas en tableau vide.
 */
const isEmptyAnswer = (o: Json): boolean => typeof o.resultat === "string";

// ── Les traducteurs, un par forme canonique ────────────────────────────────────────────────


/** `directory_lookup` — une ou plusieurs personnes avec toutes leurs coordonnées. */
function fromDirectoryLookup(o: Json): WorkspaceBlock[] {
  const people: WorkspacePerson[] = [];
  for (const p of arr(o.personnes)) {
    if (!isObj(p)) continue;
    const nom = s(p.nom);
    if (!nom) continue;
    people.push({
      nom,
      poste: s(p.poste),
      entite: s(p.entite),
      departement: s(p.departement),
      coordonnees: endpointsOf(p.coordonnees),
    });
  }
  if (people.length === 0) return [];
  return [{
    kind: "people",
    title: people.length === 1 ? people[0].nom : `${people.length} personnes trouvées`,
    people: people.slice(0, WORKSPACE_LIMITS.people),
    ...(s(o.note) ? { note: s(o.note) as string } : {}),
  }];
}

/** `directory_list` — le registre. Les adresses y sont une LISTE par personne, pas une seule. */
function fromDirectoryList(o: Json): WorkspaceBlock[] {
  const rows: WorkspacePerson[] = [];
  for (const e of arr(o.salaries)) {
    if (!isObj(e)) continue;
    const nom = s(e.nom);
    if (!nom) continue;
    const mails = endpointsOf(e.emails).map((x) => ({ ...x, canal: "e-mail" as const }));
    const tels: WorkspaceEndpoint[] = strings(e.telephones, 3).map((valeur) => ({ canal: "téléphone" as const, valeur }));
    rows.push({
      nom, poste: s(e.poste), departement: s(e.departement), entite: s(e.entite),
      coordonnees: [...mails, ...tels],
    });
  }
  if (rows.length === 0) return [];
  const total = typeof o.total === "number" ? o.total : rows.length;
  return [{
    kind: "directory",
    title: "Annuaire",
    total,
    rows: rows.slice(0, WORKSPACE_LIMITS.tableRows),
    ...(s(o.note) ? { note: s(o.note) as string } : {}),
  }];
}

/** `gmail_search` — des messages reçus. */
function fromMail(o: Json): WorkspaceBlock[] {
  const messages: WorkspaceMail[] = [];
  for (const m of arr(o.messages)) {
    if (!isObj(m)) continue;
    const de = s(m.de);
    if (!de) continue;
    const alerte = strings(m.alerteManipulation, 3);
    messages.push({
      de,
      objet: s(m.objet) ?? "(sans objet)",
      ...(s(m.id) ? { id: s(m.id) as string } : {}),
      ...(s(m.recuLe) ? { recuLe: s(m.recuLe) as string } : {}),
      ...(s(m.importance) ? { importance: s(m.importance) as string } : {}),
      ...(clip(s(m.extrait), WORKSPACE_LIMITS.snippetChars) ? { extrait: clip(s(m.extrait), WORKSPACE_LIMITS.snippetChars) as string } : {}),
      ...(strings(m.piecesJointes, 5).length ? { piecesJointes: strings(m.piecesJointes, 5) } : {}),
      ...(strings(m.demandes, 3).length ? { demandes: strings(m.demandes, 3) } : {}),
      ...(alerte.length ? { alerte } : {}),
    });
  }
  if (messages.length === 0) return [];
  return [{
    kind: "mail",
    title: messages.length === 1 ? "1 message" : `${messages.length} messages`,
    messages: messages.slice(0, WORKSPACE_LIMITS.mails),
  }];
}

/** `read_calendar` — un TABLEAU d'événements, pas un objet enveloppe. */
function fromCalendar(list: unknown[]): WorkspaceBlock[] {
  const events: WorkspaceEvent[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const titre = s(e.titre);
    if (!titre) continue;
    events.push({
      titre,
      ...(s(e.jour) ? { jour: s(e.jour) as string } : {}),
      ...(s(e.heure) ? { heure: s(e.heure) as string } : {}),
      lieu: s(e.lieu),
      organisateur: s(e.organisateur),
      visio: s(e.visio),
      ...(strings(e.invites, 8).length ? { invites: strings(e.invites, 8) } : {}),
    });
  }
  if (events.length === 0) return [];
  return [{
    kind: "agenda",
    title: events.length === 1 ? "Prochain rendez-vous" : "Agenda",
    events: events.slice(0, WORKSPACE_LIMITS.events),
  }];
}



/** `list_pending_decisions` — la file. Chaque élément porte au moins un intitulé. */
function fromQueue(o: Json): WorkspaceBlock[] {
  const items: WorkspaceItem[] = [];
  for (const it of arr(o.elements)) {
    if (!isObj(it)) continue;
    const titre = s(it.titre) ?? s(it.libelle) ?? s(it.objet) ?? s(it.type);
    if (!titre) continue;
    const actions = actionsOf(it.actions);
    items.push({
      titre,
      detail: clip(s(it.detail) ?? s(it.demandeur) ?? s(it.description), WORKSPACE_LIMITS.snippetChars),
      statut: s(it.statut) ?? s(it.etat),
      echeance: s(it.echeance) ?? s(it.date) ?? s(it.depuis),
      href: s(it.lien) ?? s(it.href),
      ...(actions.length ? { actions } : {}),
    });
  }
  if (items.length === 0) return [];
  const total = typeof o.total === "number" ? o.total : items.length;
  return [{
    kind: "queue",
    title: "En attente de votre décision",
    total,
    items: items.slice(0, WORKSPACE_LIMITS.queueItems),
  }];
}

/**
 * `inspect_record` — la fiche canonique. Sa forme varie selon le type d'enregistrement, donc
 * on ne suppose rien : on aplatit les champs SCALAIRES du premier niveau. Les sous-objets et
 * les listes sont laissés au texte, qui sait les résumer ; les afficher tous ferait de la
 * fiche un vidage de base, ce que le protocole refuse.
 */
function fromRecord(o: Json): WorkspaceBlock[] {
  const source = isObj(o.fiche) ? o.fiche : isObj(o.enregistrement) ? o.enregistrement : o;
  const fields: WorkspaceField[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (fields.length >= WORKSPACE_LIMITS.recordFields) break;
    if (k === "id" || k === "lien" || k === "href" || k === "type") continue;
    const value = typeof v === "boolean" ? (v ? "oui" : "non") : s(v);
    if (!value) continue;
    fields.push({ label: humanize(k), value: clip(value, WORKSPACE_LIMITS.snippetChars) as string });
  }
  if (fields.length < 2) return [];
  const title = s(source.nom) ?? s(source.titre) ?? s(source.libelle) ?? s(o.titre) ?? "Fiche";
  return [{
    kind: "record",
    title,
    subtitle: s(source.type) ?? s(o.type),
    href: s(source.lien) ?? s(o.lien),
    // Le titre ne se répète pas dans les champs.
    fields: fields.filter((f) => f.value !== title),
  }];
}



/** Ce qui fait fonctionner l'application sans rien apprendre au PDG. */
const STRUCTURAL_KEYS = new Set(["id", "lien", "href", "url", "cle", "key", "uuid"]);

/**
 * LE REPLI GÉNÉRIQUE, ET SA LIMITE. Une liste d'objets HOMOGÈNES devient un tableau — mais
 * seulement si l'appelant l'a explicitement autorisé pour cet outil. Appliqué à n'importe
 * quelle sortie, ce serait précisément le vidage qu'on interdit.
 */
export function tableFromRows(title: string, list: unknown[]): WorkspaceBlock | null {
  const rows = list.filter(isObj).slice(0, WORKSPACE_LIMITS.tableRows);
  if (rows.length < 2) return null;

  // Les colonnes sont celles que PARTAGE la majorité des lignes : une clé présente une fois
  // sur trente produit une colonne vide, qui coûte de la largeur et n'apprend rien.
  const counts = new Map<string, number>();
  for (const r of rows) for (const k of Object.keys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = [...counts.entries()]
    .filter(([, n]) => n >= rows.length * 0.6)
    // Les clés de PLOMBERIE ne sont pas des colonnes : un identifiant technique occupe une
    // pleine largeur et n'apprend rien au PDG.
    .filter(([k]) => !STRUCTURAL_KEYS.has(k))
    .map(([k]) => k)
    .slice(0, 6);
  if (keys.length === 0) return null;

  const columns: WorkspaceColumn[] = keys.map((k) => ({
    key: k,
    label: humanize(k),
    numeric: rows.every((r) => r[k] === undefined || typeof r[k] === "number"),
  }));
  const out: WorkspaceRow[] = rows.map((r) => {
    const cells: Record<string, string> = {};
    for (const k of keys) cells[k] = clip(s(r[k]), 80) ?? "—";
    // LE LIEN DE LA LIGNE SURVIT À LA DISPARITION DE SA COLONNE. `lien` est écarté des colonnes
    // (c'est de la plomberie), mais c'est lui qui rend la ligne cliquable — le perdre
    // renverrait le PDG à chercher lui-même la fiche qu'il a sous les yeux.
    const href = s(r.lien) ?? s(r.href);
    return { cells, ...(href ? { href } : {}) };
  });
  return { kind: "table", title, columns: out.length ? columns : [], rows: out, total: list.length };
}

/**
 * LA TABLE DE CORRESPONDANCE — outil canonique → traducteur.
 *
 * Elle est FERMÉE, et c'est le point. Un outil absent d'ici ne compose rien : sa réponse
 * reste du texte. Ajouter une entrée est une décision explicite, prise en connaissance de ce
 * que l'outil rend.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES QUI RENDENT DES LIGNES — « Dans un tableau ».
 *
 * LE DÉFAUT QU'ON FERME. En production, le PDG a demandé les dossiers Regulatory les plus
 * avancés, puis simplement : « Dans un tableau ». Réponse d'Adam : « Je ne peux pas afficher de
 * tableaux Markdown ici. » Quelques tours plus loin, sur un export : « Je ne peux pas afficher un
 * fichier Excel. » Les deux phrases sont FAUSSES. Le protocole a un bloc `table` depuis sa
 * création ; ce qui manquait, c'était le chemin qui y mène.
 *
 * La règle de style interdit — à raison — d'ÉCRIRE du Markdown : la conversation rend du texte
 * brut, et un tableau tapé à la main y arriverait en bouillie. Mais elle ne disait pas que
 * l'écran, lui, sait en construire un à partir de la donnée canonique. Le modèle en a déduit une
 * impossibilité là où il n'y avait qu'un partage des rôles.
 *
 * LA TABLE RESTE FERMÉE. Chaque entrée nomme l'outil ET l'endroit où lire ses lignes. On ne
 * transforme pas « toute sortie contenant un tableau » en tableau : c'est exactement le vidage
 * qui a mis six lignes de salaire à l'écran en réponse à « Bonsoir, ça va ? ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const TABLE_TOOLS: Record<string, { title: string; keys: readonly string[] }> = {
  // Sortie en TABLEAU NU — la lecture rend directement ses lignes.
  search_courriers: { title: "Courriers", keys: [] },
  // Sortie en OBJET — les lignes sont sous l'une de ces clés, dans cet ordre de préférence.
  regulatory_portfolio: { title: "Dossiers Regulatory", keys: ["dossiers"] },
  regulatory_workload: { title: "Charge Regulatory", keys: ["repartition"] },
  read_budget: { title: "Budget", keys: ["postes", "parEnveloppe"] },
  read_hr_overview: { title: "Effectif par entité", keys: ["parEntite"] },
};

function fromTableTool(tool: string, data: Json | unknown[]): WorkspaceBlock[] {
  const cfg = TABLE_TOOLS[tool];
  if (!cfg) return [];
  if (Array.isArray(data)) {
    const b = tableFromRows(cfg.title, data);
    return b ? [b] : [];
  }
  for (const k of cfg.keys) {
    const rows = data[k];
    if (!Array.isArray(rows)) continue;
    const b = tableFromRows(cfg.title, rows);
    if (b) return [b];
  }
  return [];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `_blocs` — QUAND UNE LECTURE DÉCLARE ELLE-MÊME CE QU'ELLE MONTRE.
 *
 * LE PROBLÈME QUE ÇA RÉSOUT. Les traducteurs ci-dessus DEVINENT une forme à partir d'un JSON.
 * C'est le bon mécanisme pour l'annuaire ou la boîte mail, dont la forme est stable. Ça ne
 * marche pas pour « montre-moi ce contrat », « où en est ce dossier », « fais-moi voir l'Excel
 * avant de l'envoyer » : ce qu'il faut afficher — un PDF, une jauge, une feuille lue — n'est pas
 * inférable d'un objet, il est CONNU de l'outil qui l'a produit.
 *
 * CE QUE ÇA NE ROUVRE PAS. Le modèle n'écrit toujours RIEN ici : `_blocs` est rempli par du code
 * serveur, dans un outil canonique, et il est REVALIDÉ champ par champ ci-dessous — type de bloc
 * inconnu écarté, champ manquant écarté, listes bornées, `href` restreint aux routes internes.
 * Ce qui reste interdit, c'est ce qui a produit l'incident des six salaires : l'inférence
 * automatique sur une forme inconnue. Une déclaration explicite d'un développeur n'en est pas une.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */


/** Un bloc déclaré par un outil, relu champ par champ. Ce qui ne passe pas est ÉCARTÉ. */
function readBlock(v: unknown): WorkspaceBlock | null {
  if (!isObj(v)) return null;
  const title = s(v.title) ?? s(v.titre);
  if (!title) return null;

  if (v.kind === "progress") {
    const gauges: WorkspaceGauge[] = [];
    for (const g of arr(v.gauges ?? v.jauges)) {
      if (!isObj(g)) continue;
      const label = clip(s(g.label) ?? s(g.libelle), 60);
      const valeur = num(g.valeur) ?? num(g.value);
      if (!label || valeur === null) continue;
      const ton = s(g.ton);
      gauges.push({
        label, valeur,
        ...(num(g.total) !== null ? { total: num(g.total) as number } : {}),
        ...(s(g.unite) ? { unite: s(g.unite) } : {}),
        ...(s(g.detail) ? { detail: clip(s(g.detail), 80) } : {}),
        ...(ton && TONES.has(ton) ? { ton: ton as WorkspaceGauge["ton"] } : {}),
      });
      if (gauges.length >= WORKSPACE_LIMITS.gauges) break;
    }
    if (gauges.length === 0) return null;
    return { kind: "progress", title, gauges, ...(s(v.note) ? { note: s(v.note) } : {}) };
  }

  if (v.kind === "document") {
    const docs: WorkspaceDoc[] = [];
    for (const d of arr(v.docs ?? v.documents)) {
      if (!isObj(d)) continue;
      const nom = clip(s(d.nom) ?? s(d.name), 120);
      const href = s(d.href) ?? s(d.lien);
      if (!nom || !href || !isInternalHref(href)) continue;
      const type = s(d.type);
      const feuille = readSheet(d.feuille);
      docs.push({
        nom, href,
        type: (type && DOC_KINDS.has(type) ? type : "autre") as WorkspaceDoc["type"],
        ...(s(d.mime) ? { mime: s(d.mime) } : {}),
        ...(s(d.soustitre) ? { soustitre: clip(s(d.soustitre), 120) } : {}),
        ...(s(d.taille) ? { taille: s(d.taille) } : {}),
        ...(s(d.date) ? { date: s(d.date) } : {}),
        ...(num(d.pages) !== null ? { pages: num(d.pages) as number } : {}),
        ...(feuille ? { feuille } : {}),
      });
      if (docs.length >= WORKSPACE_LIMITS.docs) break;
    }
    if (docs.length === 0) return null;
    return { kind: "document", title, docs, ...(s(v.note) ? { note: s(v.note) } : {}) };
  }

  if (v.kind === "table") {
    const columns = readColumns(v.columns);
    const rows = readRows(v.rows, columns);
    if (columns.length === 0 || rows.length === 0) return null;
    return { kind: "table", title, columns, rows, total: num(v.total) ?? rows.length };
  }

  if (v.kind === "people") {
    // Une fiche RICHE — la même forme que `fromDirectoryLookup`, mais déclarée par l'outil qui
    // sait, lui, combien de dossiers cette personne porte et combien sont en retard.
    const people: WorkspacePerson[] = [];
    for (const p of arr(v.people ?? v.personnes)) {
      const person = readPerson(p);
      if (person) people.push(person);
      if (people.length >= WORKSPACE_LIMITS.people) break;
    }
    if (people.length === 0) return null;
    return {
      kind: "people", title, people,
      ...(s(v.note) ? { note: s(v.note) as string } : {}),
      ...(actionsOf(v.actions).length ? { actions: actionsOf(v.actions) } : {}),
    };
  }

  if (v.kind === "dossier") {
    const fields: WorkspaceField[] = [];
    for (const f of arr(v.fields ?? v.champs)) {
      if (!isObj(f)) continue;
      const label = clip(s(f.label) ?? s(f.libelle), 40);
      const value = clip(s(f.value) ?? s(f.valeur), WORKSPACE_LIMITS.snippetChars);
      if (!label || !value) continue;
      // Un champ qui DÉSIGNE quelqu'un porte son visage. La photo suit la même règle que
      // partout ailleurs : route interne, sinon on garde le nom seul.
      const av = isObj(f.avatar) ? f.avatar : null;
      const avNom = av ? clip(s(av.nom) ?? s(av.name), 80) : null;
      const avPhoto = av ? s(av.photo) : null;
      fields.push({
        label, value,
        ...(avNom ? { avatar: { nom: avNom, ...(avPhoto && isInternalHref(avPhoto) ? { photo: avPhoto } : {}) } } : {}),
        ...(tonOf(f.ton) ? { ton: tonOf(f.ton) } : {}),
        ...(readEditable(f.editable) ? { editable: readEditable(f.editable) } : {}),
      });
      if (fields.length >= WORKSPACE_LIMITS.recordFields) break;
    }

    const steps: WorkspaceStep[] = [];
    for (const st of arr(v.steps ?? v.etapes)) {
      if (!isObj(st)) continue;
      const label = clip(s(st.label) ?? s(st.libelle), 28);
      const etat = s(st.etat);
      if (!label) continue;
      steps.push({ label, etat: etat === "fait" || etat === "courant" ? etat : "a-venir" });
      if (steps.length >= WORKSPACE_LIMITS.steps) break;
    }

    const docs: WorkspaceDoc[] = [];
    for (const d of arr(v.docs)) {
      if (!isObj(d)) continue;
      const nom = clip(s(d.nom) ?? s(d.name), 120);
      const href = s(d.href) ?? s(d.lien);
      if (!nom || !href || !isInternalHref(href)) continue;
      const type = s(d.type);
      docs.push({
        nom, href,
        type: (type && DOC_KINDS.has(type) ? type : "autre") as WorkspaceDoc["type"],
        ...(s(d.taille) ? { taille: s(d.taille) } : {}),
        ...(s(d.date) ? { date: s(d.date) } : {}),
        ...(s(d.soustitre) ? { soustitre: clip(s(d.soustitre), 60) } : {}),
      });
      if (docs.length >= WORKSPACE_LIMITS.docs + 3) break;
    }

    const participants: WorkspacePerson[] = [];
    for (const p of arr(v.participants)) {
      const person = readPerson(p);
      if (person) participants.push(person);
      if (participants.length >= WORKSPACE_LIMITS.participants) break;
    }

    const activite: { date?: string | null; label: string }[] = [];
    for (const a of arr(v.activite ?? v.activity)) {
      if (!isObj(a)) continue;
      const label = clip(s(a.label) ?? s(a.libelle), WORKSPACE_LIMITS.snippetChars);
      if (!label) continue;
      activite.push({ label, date: s(a.date) });
      if (activite.length >= WORKSPACE_LIMITS.activity) break;
    }

    // UN DOSSIER SANS AUCUN CONTENU N'EST PAS UN DOSSIER. Une carte vide avec quatre boutons
    // promet un objet qui n'existe pas.
    if (fields.length === 0 && steps.length === 0) return null;

    const alerteLabel = clip(s(isObj(v.alerte) ? v.alerte.label : v.alerte), WORKSPACE_LIMITS.snippetChars);
    const badgeLabel = clip(s(isObj(v.badge) ? v.badge.label : v.badge), 24);
    const href = s(v.href) ?? s(v.lien);
    return {
      kind: "dossier", title,
      ...(s(v.subtitle) ?? s(v.soustitre) ? { subtitle: (s(v.subtitle) ?? s(v.soustitre)) as string } : {}),
      ...(badgeLabel ? { badge: { label: badgeLabel, ton: tonOf(isObj(v.badge) ? v.badge.ton : null, "neutre")! } } : {}),
      fields,
      ...(steps.length ? { steps } : {}),
      ...(alerteLabel ? { alerte: { label: alerteLabel, ton: tonOf(isObj(v.alerte) ? v.alerte.ton : null, "alerte") === "attention" ? "attention" : "alerte" } } : {}),
      ...(docs.length ? { docs } : {}),
      ...(participants.length ? { participants } : {}),
      ...(activite.length ? { activite } : {}),
      ...(href && isInternalHref(href) ? { href } : {}),
      ...(actionsOf(v.actions, WORKSPACE_LIMITS.blockActions).length ? { actions: actionsOf(v.actions, WORKSPACE_LIMITS.blockActions) } : {}),
    };
  }

  if (v.kind === "email") {
    const a = strings(v.a ?? v.to, 8);
    const corps = clip(s(v.corps) ?? s(v.body), 4000);
    if (a.length === 0 || !corps) return null;
    const statut = s(v.statut);
    return {
      kind: "email", title,
      a,
      ...(strings(v.cc, 8).length ? { cc: strings(v.cc, 8) } : {}),
      objet: clip(s(v.objet) ?? s(v.subject), 200) ?? "(sans objet)",
      corps,
      ...(strings(v.piecesJointes, 5).length ? { piecesJointes: strings(v.piecesJointes, 5) } : {}),
      statut: statut === "envoye" || statut === "annule" ? statut : "brouillon",
      ...(s(v.envoyeLe) ? { envoyeLe: s(v.envoyeLe) } : {}),
      ...(actionsOf(v.actions, WORKSPACE_LIMITS.blockActions).length ? { actions: actionsOf(v.actions, WORKSPACE_LIMITS.blockActions) } : {}),
    };
  }

  if (v.kind === "timeline") {
    const steps: { date?: string | null; label: string; detail?: string | null }[] = [];
    for (const st of arr(v.steps ?? v.etapes)) {
      if (!isObj(st)) continue;
      const label = clip(s(st.label) ?? s(st.libelle), 120);
      if (!label) continue;
      steps.push({ label, date: s(st.date), detail: clip(s(st.detail), WORKSPACE_LIMITS.snippetChars) });
      if (steps.length >= WORKSPACE_LIMITS.timelineSteps) break;
    }
    if (steps.length === 0) return null;
    return { kind: "timeline", title, steps };
  }

  // LA REPRÉSENTATION GÉNÉRIQUE (§35) : une forme parmi dix-sept, ses données relues par famille ;
  // et le mini-tableau de bord, dont chaque tuile repasse par CE lecteur.
  if (v.kind === "viz") return readVizBlock(v, title);
  if (v.kind === "dashboard") return readDashboardBlock(v, title, readBlock);

  // LES BLOCS RICHES (story, 360, comparaison, mission, alerte) sont relus dans un module à
  // part : leur validation est longue, et la mêler aux sept traducteurs ci-dessus aurait donné
  // un `readBlock` de six cents lignes qu'on ne relit plus. Même exigence, même refus du
  // laxisme : ce qui ne passe pas champ par champ n'est pas affiché.
  const riche = readGodmodeBlock(v, title);
  if (riche) return riche;

  // Tout autre `kind` — y compris ceux qui ont déjà un traducteur dédié : on ne veut pas deux
  // chemins pour la même forme, et surtout pas un chemin qui contourne la validation.
  return null;
}

function declaredBlocks(data: Json): WorkspaceBlock[] {
  const out: WorkspaceBlock[] = [];
  for (const b of arr(data._blocs)) {
    const parsed = readBlock(b);
    if (parsed) out.push(parsed);
    if (out.length >= 4) break;
  }
  if (out.length === 0) {
    const t = fromDeclaredRows(data);
    if (t) out.push(t);
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `_lignes` — UNE CAPACITÉ QU'ON N'A PAS ÉCRITE, À L'ÉCRAN.
 *
 * `TABLE_TOOLS` nomme des outils écrits DANS LE CŒUR. Une capacité dynamique n'y figurera
 * jamais — connecteur déclaré par manifeste, micro-outil créé par Adam dans le tour, playbook
 * enseigné — et il n'existe aucun endroit où aller ajouter l'entrée manquante : c'est
 * exactement ce qui rend un runtime de skills extensible (§118.58). Onze capacités déclarées,
 * deux d'entre elles rendant des LISTES, ne pouvaient donc rien afficher, en silence.
 *
 * CE N'EST PAS L'INFÉRENCE AVEUGLE QU'ON INTERDIT. Rien n'est deviné ici : `_lignes` est posé
 * par le runtime des skills, qui a lu `sorties.cles` du MANIFESTE et vérifié que la clé porte
 * bien des lignes. Même modèle de confiance que `_blocs` — une déclaration de code serveur —
 * et la traduction reste celle de `tableFromRows`, la seule du fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function fromDeclaredRows(data: Json): WorkspaceBlock | null {
  const d = data._lignes;
  if (!isObj(d)) return null;
  const titre = clip(s(d.titre), 80);
  const chemin = s(d.chemin);
  if (!titre || !chemin) return null;
  const rows = suivreChemin(data, chemin);
  if (!Array.isArray(rows)) return null;
  return tableFromRows(titre, rows);
}

export function composeWorkspace(tool: string, raw: string): WorkspaceComposition | null {
  const data = parse(raw);
  if (data === null) return null;

  let blocks: WorkspaceBlock[] = [];
  if (Array.isArray(data)) {
    if (tool === "read_calendar") blocks = fromCalendar(data);
    else blocks = fromTableTool(tool, data);
  } else {
    if (isEmptyAnswer(data)) return null;
    // Ce que l'outil DÉCLARE passe d'abord : il en sait plus que n'importe quelle inférence.
    blocks = declaredBlocks(data);
    if (blocks.length === 0) {
      switch (tool) {
        case "directory_lookup": blocks = fromDirectoryLookup(data); break;
        case "directory_list": blocks = fromDirectoryList(data); break;
        case "gmail_search": blocks = fromMail(data); break;
        case "list_pending_decisions": blocks = fromQueue(data); break;
        case "inspect_record": blocks = fromRecord(data); break;
        default: blocks = fromTableTool(tool, data);
      }
    }
  }

  if (blocks.length === 0) return null;
  return { source: tool, blocks };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE MODÈLE N'A PAS BESOIN DE LIRE — et pourquoi il faut le DÉCLARER.
 *
 * `_blocs` porte la charge d'AFFICHAGE : identifiants de jalons, chemins de pièces, libellés de
 * boutons, couleurs. Sur une histoire d'affaire de quatre-vingts jalons, elle dépasse le reste
 * d'un ordre de grandeur — et le modèle la recevait mot pour mot sans jamais s'en servir.
 *
 * ── LA PREMIÈRE VERSION ÉTAIT FAUSSE, ET C'ÉTAIT GRAVE ───────────────────────────────────
 *
 * Elle retirait `_blocs` de TOUTE sortie. L'audit hostile a trouvé deux régressions réelles :
 *
 *   • le BROUILLON D'E-MAIL — `corps` n'existe QUE dans le bloc. Après le retrait, « raccourcis
 *     le deuxième paragraphe » devenait impossible : le modèle ne voyait plus le message ;
 *   • le TABLEAU SUR MESURE — les lignes n'existent QUE dans le bloc. « Lequel a le plus gros
 *     montant ? » n'avait plus de réponse, alors que la question porte sur ce qui est à l'écran.
 *
 * Échanger des jetons contre des FAITS est le pire marché possible : l'économie se voit dans un
 * tableau de mesures, la perte se voit six mois plus tard dans une réponse fausse.
 *
 * ── LA RÈGLE TENUE DEPUIS : L'OUTIL DÉCLARE, ET LE DÉFAUT EST DE GARDER ──────────────────
 *
 * Seule une sortie marquée `_blocsDecoratifs: true` est allégée. L'outil qui pose ce drapeau
 * affirme que TOUT ce dont le modèle a besoin figure ailleurs dans la même réponse. Sans le
 * drapeau, rien n'est retiré — un outil écrit demain par quelqu'un qui n'a pas lu ceci ne perd
 * donc aucune donnée par inadvertance.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function stripDisplayPayload(raw: string): string {
  const data = parse(raw);
  if (data === null || Array.isArray(data)) return raw;
  // `_provenance` (F8) est une LIGNÉE déclarée pour le registre des faits, jamais une donnée à
  // raisonner : elle part toujours — jusqu'à deux cents références d'écritures n'ont rien à faire
  // dans le contexte d'un modèle qui a déjà le total et le nombre d'écritures.
  const decoratifs = data._blocsDecoratifs === true && "_blocs" in data;
  if (!decoratifs && !("_provenance" in data)) return raw;
  const { _blocs, _blocsDecoratifs, _provenance, ...reste } = data;
  void _provenance;
  if (!decoratifs) return JSON.stringify({ ...reste, ...("_blocs" in data ? { _blocs, _blocsDecoratifs } : {}) });
  void _blocs; void _blocsDecoratifs;
  return JSON.stringify(reste);
}

/** Les outils qui savent composer — utile aux tests et à l'observabilité. */
export const COMPOSABLE_TOOLS: readonly string[] = [
  "directory_lookup", "directory_list", "gmail_search",
  "read_calendar", "list_pending_decisions", "inspect_record",
  ...Object.keys(TABLE_TOOLS),
];
