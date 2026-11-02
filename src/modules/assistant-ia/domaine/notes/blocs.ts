/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES BLOCS (décision 0026) — règle PURE, zéro import : l'éditeur (navigateur), le serveur et les
 * outils de l'assistant partagent la même définition d'une page.
 *
 * Une page = une liste PLATE de blocs ; l'imbrication est un NIVEAU (0 à 4), comme un plan : un bloc et ceux qui le
 * suivent avec un niveau plus grand forment son SOUS-ARBRE — Tab, Maj+Tab et le glisser le déplacent entier.
 *
 *   texte   un paragraphe          titre   un intertitre (« Cette semaine »)
 *   puce    une liste à puces      tache   une case à cocher (cochée = barrée)
 *
 * Raccourcis en début de ligne : « - » ou « * » → puce, « [] » → case, « [x] » → case cochée, « # » → titre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TypeBloc = "texte" | "titre" | "puce" | "tache";
export const TYPES_BLOC: readonly TypeBloc[] = ["texte", "titre", "puce", "tache"];

export interface BlocNote {
  id: string;
  type: TypeBloc;
  texte: string;
  /** Une case cochée (type `tache`). */
  fait?: boolean;
  /** 0 à `NIVEAU_MAX` ; jamais plus d'un cran au-dessus du bloc précédent. */
  niveau: number;
}

export const NIVEAU_MAX = 4;
export const TEXTE_MAX = 2_000;
export const BLOCS_MAX = 500;
export const TITRE_PAGE_MAX = 80;
export const PAGES_MAX = 50;
export const TITRE_PAGE_DEFAUT = "Mes notes";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RE_ID = /^[a-z0-9]{6,16}$/;

/** Un identifiant de bloc court (8 caractères) — l'assistant le cite pour désigner une ligne. */
export function nouvelIdBloc(alea: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(alea() * ALPHABET.length) % ALPHABET.length];
  return s;
}

export function estTypeBloc(v: unknown): v is TypeBloc {
  return typeof v === "string" && (TYPES_BLOC as readonly string[]).includes(v);
}

export function blocVide(type: TypeBloc = "texte", niveau = 0, alea?: () => number): BlocNote {
  return { id: nouvelIdBloc(alea), type, texte: "", niveau, ...(type === "tache" ? { fait: false } : {}) };
}

/** Un texte de bloc : une seule ligne, sans caractère de contrôle, borné. */
export function nettoyerTexte(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\s*\n\s*/g, " ").slice(0, TEXTE_MAX);
}

export function nettoyerTitrePage(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, TITRE_PAGE_MAX);
}

/** Les niveaux remis en ordre : le premier à 0, aucun saut de plus d'un cran, bornés. */
export function normaliserNiveaux(blocs: BlocNote[]): BlocNote[] {
  let prec = -1;
  return blocs.map((b) => {
    const niveau = Math.max(0, Math.min(NIVEAU_MAX, prec + 1, Math.trunc(b.niveau) || 0));
    prec = niveau;
    return niveau === b.niveau ? b : { ...b, niveau };
  });
}

/**
 * CE QUI ARRIVE DU NAVIGATEUR OU DE LA BASE, rendu sûr : types connus, textes bornés, identifiants uniques
 * (un doublon reçoit un identifiant neuf), au plus `BLOCS_MAX` blocs, niveaux en ordre.
 */
export function normaliserBlocs(x: unknown, alea?: () => number): BlocNote[] {
  if (!Array.isArray(x)) return [];
  const vus = new Set<string>();
  const out: BlocNote[] = [];
  for (const brut of x.slice(0, BLOCS_MAX)) {
    if (!brut || typeof brut !== "object") continue;
    const o = brut as Record<string, unknown>;
    const type: TypeBloc = estTypeBloc(o.type) ? o.type : "texte";
    let id = typeof o.id === "string" && RE_ID.test(o.id) ? o.id : nouvelIdBloc(alea);
    while (vus.has(id)) id = nouvelIdBloc(alea);
    vus.add(id);
    out.push({
      id, type, texte: nettoyerTexte(o.texte), niveau: typeof o.niveau === "number" ? o.niveau : 0,
      ...(type === "tache" ? { fait: o.fait === true } : {}),
    });
  }
  return normaliserNiveaux(out);
}

/**
 * LES RACCOURCIS DE DÉBUT DE LIGNE — « - » ou « * » puce, « [] » / « [ ] » case, « [x] » case cochée, « # » titre ;
 * rend le bloc transformé (préfixe ôté), ou `null` si rien ne s'applique. Un titre ou une case déjà typés ne se
 * re-transforment pas : « - » au début d'une case reste du texte.
 */
export function raccourci(b: BlocNote): BlocNote | null {
  if (b.type !== "texte") return null;
  const m = /^(?:(-|\*)|(\[\s?\])|(\[[xX]\])|(#{1,3}))\s(.*)$/s.exec(b.texte);
  if (!m) return null;
  const reste = m[5] ?? "";
  if (m[1]) return { id: b.id, type: "puce", texte: reste, niveau: b.niveau };
  if (m[2]) return { id: b.id, type: "tache", texte: reste, fait: false, niveau: b.niveau };
  if (m[3]) return { id: b.id, type: "tache", texte: reste, fait: true, niveau: b.niveau };
  return { id: b.id, type: "titre", texte: reste, niveau: b.niveau };
}

export function indexDe(blocs: readonly BlocNote[], id: string): number {
  return blocs.findIndex((b) => b.id === id);
}

/** Le sous-arbre d'un bloc : [début, fin) — lui, et ceux qui le suivent avec un niveau plus grand. */
export function sousArbre(blocs: readonly BlocNote[], index: number): [number, number] {
  if (index < 0 || index >= blocs.length) return [index, index];
  const n = blocs[index].niveau;
  let fin = index + 1;
  while (fin < blocs.length && blocs[fin].niveau > n) fin++;
  return [index, fin];
}

/** Tab : le bloc (et son sous-arbre) d'un cran à droite — pas plus d'un cran sous le bloc qui le précède. */
export function indenter(blocs: readonly BlocNote[], id: string): BlocNote[] {
  const i = indexDe(blocs, id);
  if (i <= 0) return [...blocs];
  const [debut, fin] = sousArbre(blocs, i);
  if (blocs[i].niveau >= Math.min(NIVEAU_MAX, blocs[i - 1].niveau + 1)) return [...blocs];
  if (blocs.slice(debut, fin).some((b) => b.niveau >= NIVEAU_MAX)) return [...blocs];
  return blocs.map((b, k) => (k >= debut && k < fin ? { ...b, niveau: b.niveau + 1 } : b));
}

/** Maj+Tab : le bloc (et son sous-arbre) d'un cran à gauche. */
export function desindenter(blocs: readonly BlocNote[], id: string): BlocNote[] {
  const i = indexDe(blocs, id);
  if (i < 0 || blocs[i].niveau === 0) return [...blocs];
  const [debut, fin] = sousArbre(blocs, i);
  return normaliserNiveaux(blocs.map((b, k) => (k >= debut && k < fin ? { ...b, niveau: Math.max(0, b.niveau - 1) } : b)));
}

/**
 * DÉPLACER une ligne (et son sous-arbre) juste APRÈS `apresId` — `null` : en tête de page. Le sous-arbre prend le
 * niveau de la ligne qui le précède désormais (un plan reste un plan). Sans effet si la cible est dans le sous-arbre.
 */
export function deplacerApres(blocs: readonly BlocNote[], id: string, apresId: string | null): BlocNote[] {
  const i = indexDe(blocs, id);
  if (i < 0 || apresId === id) return [...blocs];
  const [debut, fin] = sousArbre(blocs, i);
  const bloc = blocs.slice(debut, fin);
  if (apresId && bloc.some((b) => b.id === apresId)) return [...blocs];
  const reste = [...blocs.slice(0, debut), ...blocs.slice(fin)];
  const j = apresId === null ? -1 : indexDe(reste, apresId);
  if (apresId !== null && j < 0) return [...blocs];
  // Après une ligne : on se range après SON sous-arbre (on ne s'insère pas entre un parent et ses enfants).
  const [, finCible] = j < 0 ? [0, 0] : sousArbre(reste, j);
  const niveauCible = j < 0 ? 0 : reste[j].niveau;
  const decalage = niveauCible - bloc[0].niveau;
  const pose = bloc.map((b) => ({ ...b, niveau: Math.max(0, b.niveau + decalage) }));
  return normaliserNiveaux([...reste.slice(0, finCible), ...pose, ...reste.slice(finCible)]);
}

/**
 * LE GLISSER : la ligne (et son sous-arbre) posée au rang `versIndex` de la page SANS elle (0 = en tête) ; elle garde
 * son niveau, borné par la ligne qui la précède désormais.
 */
export function deplacerA(blocs: readonly BlocNote[], id: string, versIndex: number): BlocNote[] {
  const i = indexDe(blocs, id);
  if (i < 0) return [...blocs];
  const [debut, fin] = sousArbre(blocs, i);
  const bloc = blocs.slice(debut, fin);
  const reste = [...blocs.slice(0, debut), ...blocs.slice(fin)];
  const k = Math.max(0, Math.min(reste.length, Math.trunc(versIndex)));
  return normaliserNiveaux([...reste.slice(0, k), ...bloc, ...reste.slice(k)]);
}

/** Alt+↑ / Alt+↓ (le glisser au clavier) : par-dessus la ligne voisine de même niveau (et son sous-arbre). */
export function deplacerDUnCran(blocs: readonly BlocNote[], id: string, sens: -1 | 1): BlocNote[] {
  const i = indexDe(blocs, id);
  if (i < 0) return [...blocs];
  const [, fin] = sousArbre(blocs, i);
  if (sens === 1) {
    if (fin >= blocs.length) return [...blocs];
    const [, finSuivant] = sousArbre(blocs, fin);
    return deplacerA(blocs, id, i + (finSuivant - fin));
  }
  if (i === 0) return [...blocs];
  // Le voisin de même niveau qui précède (ou le parent) : on se pose à sa place.
  let k = i - 1;
  while (k > 0 && blocs[k].niveau > blocs[i].niveau) k--;
  return deplacerA(blocs, id, k);
}

export function inserer(blocs: readonly BlocNote[], bloc: BlocNote, apresId: string | null): BlocNote[] {
  if (apresId === null) return normaliserNiveaux([bloc, ...blocs]);
  const j = indexDe(blocs, apresId);
  if (j < 0) return normaliserNiveaux([...blocs, bloc]);
  return normaliserNiveaux([...blocs.slice(0, j + 1), bloc, ...blocs.slice(j + 1)]);
}

/** Retirer une ligne SEULE : ses enfants restent, remontés d'un cran si besoin. */
export function retirer(blocs: readonly BlocNote[], id: string): BlocNote[] {
  return normaliserNiveaux(blocs.filter((b) => b.id !== id));
}

export function cocher(blocs: readonly BlocNote[], id: string, fait: boolean): BlocNote[] {
  return blocs.map((b) => (b.id === id ? { ...b, type: "tache" as const, fait } : b));
}

export function changerType(blocs: readonly BlocNote[], id: string, type: TypeBloc): BlocNote[] {
  return blocs.map((b) => {
    if (b.id !== id || b.type === type) return b;
    const { fait: _ancien, ...reste } = b;
    return type === "tache" ? { ...reste, type, fait: false } : { ...reste, type };
  });
}

/** L'identifiant de la ligne qui précède `id` (`null` en tête) — pour remettre une ligne où elle était. */
export function precedent(blocs: readonly BlocNote[], id: string): string | null {
  const i = indexDe(blocs, id);
  return i > 0 ? blocs[i - 1].id : null;
}

/** LA CORBEILLE : les lignes NON VIDES qui ont disparu entre deux états, avec leur rang d'avant. */
export function blocsSupprimes(avant: readonly BlocNote[], apres: readonly BlocNote[]): { bloc: BlocNote; position: number }[] {
  const restent = new Set(apres.map((b) => b.id));
  return avant.flatMap((bloc, position) => (!restent.has(bloc.id) && bloc.texte.trim() ? [{ bloc, position }] : []));
}

/** Deux états identiques (rien à enregistrer). */
export function memesBlocs(a: readonly BlocNote[], b: readonly BlocNote[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.type === y.type && x.texte === y.texte && x.niveau === y.niveau && !!x.fait === !!y.fait;
  });
}

/** Le nombre de cases d'une page et combien sont cochées (« 3 / 5 »). */
export function compteCases(blocs: readonly BlocNote[]): { total: number; faites: number } {
  const cases = blocs.filter((b) => b.type === "tache");
  return { total: cases.length, faites: cases.filter((b) => b.fait).length };
}
