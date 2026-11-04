import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import type { JeuxDuTour } from "../../domaine/analyse/jeux";
import type { AccesIa } from "../../domaine/acces-regles";
import {
  champsDemandes, filtrer, LIGNES_JEU_MAX, LIGNES_RENDUES_MAX, normaliserFiltre, projeter, schemaCourt, trier, trouverChamp,
  type ChampVue, type DeclarationVue, type FiltreNormalise, type Ligne,
} from "../../domaine/primitives/vues";
import { aplatir, clauseDeFiltre, libelliser, phraseDEssai, schemaDeTable } from "../../domaine/primitives/tables";
import { estGenerique, VUES, vueNommee, type Preset, type PresetGenerique, type VueLisible } from "./vues";
import { accesParDefaut } from "../role-config";
import { champsPour, droitDeLire, ECRANS, libelleTable, modeleDecrit, PORTEES, resoudreTable, tablesProches, VIVANTES } from "./tables";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `lire` — UNE primitive pour lire TOUT l'ERP sous les droits de la personne (I3 → I4 « Adam lit tout », décision 0067).
 *
 * `{table | vue, filtres[], champs[], tri, limite, compter_par, compter, jeu}` → un JEU nommé (partagé avec `produire`,
 * `analyser_donnees`) et un aperçu borné. `table` : N'IMPORTE QUEL modèle du schéma (nom, ou libellé du catalogue des bases) ;
 * `vue` : un preset (produits, établissements, missions, tâches, demandes). Ce qui le rend sûr est dans le moteur :
 *   • les droits (`droitDeLire`) : base ouverte, familles, portée des lignes DÉCLARÉE (sinon Super Admin seul), colonnes
 *     jamais rendues — une table fermée REFUSE en nommant le droit, rien n'est lu ;
 *   • la portée est la seule clause que la base reçoit avec les filtres ; une relation suivie hors de la portée de la
 *     personne est réduite à ses colonnes de référence ;
 *   • la sortie passe le filtre du catalogue (`outils-v1.ts` : jetonnée, encadrée, consignée).
 * `compter: true` : l'ESSAI À BLANC (le plan d'une mission s'éprouve avant de partir) — combien, et comment élargir si zéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_LIRE = "lire";
/** Ce qu'une lecture de table ramène au plus de la base avant le filtre en mémoire ; au-delà : `tronque`, dit. */
const SCAN_MAX = 20_000;

const json = (o: unknown) => JSON.stringify(o);
const texte = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
type Clause = Record<string, unknown>;

function filtresRecus(brut: unknown): { champ?: unknown; op?: unknown; valeur?: unknown }[] {
  if (Array.isArray(brut)) return brut.filter((f) => f && typeof f === "object") as { champ?: unknown; op?: unknown; valeur?: unknown }[];
  if (brut && typeof brut === "object") return Object.entries(brut as Record<string, unknown>).map(([champ, valeur]) => ({ champ, op: "=", valeur }));
  return [];
}

export interface ResultatLecture { statut: string; [k: string]: unknown }
export interface OptionsLecture { acces: AccesIa; maintenant?: Date; lignesMax?: number }

/** Le modèle Prisma d'une table (son accesseur), par le relais `prisma` — la garde des données s'y applique aussi. */
const delegue = (modele: string) => (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[modele[0]!.toLowerCase() + modele.slice(1)]!;
const lien = (modele: string, l: Record<string, unknown>) => ECRANS[modele]?.replace(/<(\w+)>/g, (_, k: string) => encodeURIComponent(String(l[k] ?? ""))) ?? null;

/** Le `select` Prisma des champs nécessaires : colonnes, et relations à un niveau (vers plusieurs : sous leur portée, bornées). */
function selection(modele: string, champs: readonly ChampVue[], portees: ReadonlyMap<string, Clause>): Clause {
  const m = modeleDecrit(modele)!;
  const sel: Clause = { [m.cle]: true };
  for (const k of ["name", "updatedAt"]) if (m.champs.some((c) => c.nom === k && c.genre === "scalar")) sel[k] = true;
  for (const c of champs) {
    if (!c.chemin) continue;
    const [a, b] = c.chemin.split(".");
    if (!b) { sel[a!] = true; continue; }
    const r = m.champs.find((x) => x.nom === a)!;
    const prec = (sel[a!] as { select: Clause } | undefined)?.select ?? { [modeleDecrit(r.type)!.cle]: true };
    sel[a!] = { select: { ...prec, [b]: true }, ...(r.liste ? { where: portees.get(r.type) ?? {}, take: 50 } : {}) };
  }
  return sel;
}

/** Une fiche liée HORS de la portée de la personne (vers UNE fiche) : réduite à ses colonnes de référence, après coup. */
async function bornerLesLiees(modele: string, brutes: Record<string, unknown>[], champs: readonly ChampVue[], portees: ReadonlyMap<string, Clause>): Promise<void> {
  const m = modeleDecrit(modele)!;
  const relations = [...new Set(champs.map((c) => c.chemin?.split(".")).filter((x) => x && x.length === 2).map((x) => x![0]!))];
  for (const r of relations) {
    const def = m.champs.find((c) => c.nom === r);
    const portee = def && !def.liste ? portees.get(def.type) : undefined;
    if (!def || !portee || !Object.keys(portee).length) continue;
    const cle = modeleDecrit(def.type)!.cle;
    const ids = [...new Set(brutes.map((b) => (b[r] as Record<string, unknown> | null)?.[cle]).filter((x): x is string => typeof x === "string"))];
    if (!ids.length) continue;
    const dedans = new Set((await delegue(def.type).findMany({ where: { AND: [portee, { [cle]: { in: ids } }] }, select: { [cle]: true } })).map((x) => x[cle] as string));
    for (const b of brutes) {
      const lie = b[r] as Record<string, unknown> | null;
      if (lie?.[cle] && !dedans.has(lie[cle] as string)) b[r] = Object.fromEntries(Object.entries(lie).filter(([k]) => [cle, "name", "nom", "title", "titre", "label", "libelle"].includes(k)));
    }
  }
}

interface Cible { modele: string; preset: Preset | null }
function cibleDe(e: Record<string, unknown>): Cible | null {
  const preset = vueNommee(e.vue ?? e.table);
  if (preset) return { modele: preset.table, preset };
  const modele = resoudreTable(e.table ?? e.vue);
  return modele ? { modele, preset: null } : null;
}

/** La déclaration d'un preset générique : ses noms français posés sur les champs de la table, plus ses champs calculés. */
function declarationPreset(p: PresetGenerique, champs: readonly ChampVue[], lienDe: boolean): ChampVue[] {
  const out: ChampVue[] = [{ nom: "id", type: "texte", description: "Identifiant de la fiche.", source: { modele: p.table, champ: "id" }, chemin: "id" }];
  for (const [nom, chemin] of Object.entries(p.renomme)) {
    const c = champs.find((x) => x.chemin === chemin);
    if (c) out.push({ ...c, nom, ...(p.alias?.[nom] ? { alias: p.alias[nom] } : {}) });
  }
  out.push(...p.calcules.map((x) => x.champ));
  if (lienDe) out.push({ nom: "lien", type: "lien", description: `Lien de l'écran (${p.ecran}).`, source: { regle: "lien d'écran" } });
  return out;
}

/** EXÉCUTER une lecture : cible, droits, filtres normalisés, base puis mémoire, tri, projection, jeu inscrit. */
export async function executerVue(u: CurrentUser, e: Record<string, unknown>, jeux: Pick<JeuxDuTour, "inscrire">, opts: OptionsLecture | Date = {} as OptionsLecture): Promise<ResultatLecture> {
  // Sans accès donné (bancs) : l'accès par défaut du compte, celui de la console sans réglage lu.
  const o: OptionsLecture = opts instanceof Date ? { acces: accesParDefaut(u), maintenant: opts } : { ...opts, acces: opts.acces ?? accesParDefaut(u) };
  const maintenant = o.maintenant ?? new Date();
  const cible = cibleDe(e);
  if (!cible) {
    return { statut: "INCONNUE", raison: `table « ${String(e.table ?? e.vue ?? "")} » inconnue`, proches: tablesProches(e.table ?? e.vue), vues: VUES.map((v) => v.nom), aide: "`table` : un modèle de l'ERP (ex. MedicalDoctor, MedicalInstitution, Task) ou son nom du catalogue des bases." };
  }
  const { modele, preset } = cible;
  const droit = droitDeLire(u, o.acces, modele, preset ? PORTEES[modele] : undefined);
  const nomLu = preset?.nom ?? modele;
  if (!droit.ok) return { statut: "FERMEE", vue: nomLu, table: modele, droit: preset?.droit ?? droit.droit, raison: preset && /^(base|écran)/.test(droit.droit) ? `La vue « ${preset.nom} » demande le droit « ${preset.droit} », que votre rôle n'a pas dans l'application (réglé en Administration › Accès). Rien n'a été lu.` : droit.raison };

  // ── La déclaration ──
  let decl: DeclarationVue;
  let lireLignes: (filtres: readonly FiltreNormalise[], champsUtiles: readonly ChampVue[]) => Promise<{ lignes: Ligne[]; tronque: boolean }>;
  if (preset && !estGenerique(preset)) {
    const p = preset as VueLisible<unknown>;
    decl = p;
    lireLignes = async () => ({ lignes: await p.lire(u, droit.portee, maintenant), tronque: false });
  } else {
    const sc = champsPour(u, o.acces, modele)!;
    const avecLien = !!ECRANS[modele];
    const champs = preset ? declarationPreset(preset as PresetGenerique, sc.champs, avecLien)
      : [...sc.champs, ...(avecLien ? [{ nom: "lien", type: "lien", description: `Lien de la fiche (${ECRANS[modele]}).`, source: { regle: "lien d'écran" } } as ChampVue] : [])];
    decl = {
      nom: nomLu, description: preset?.description ?? libelleTable(modele), ecran: preset?.ecran ?? ECRANS[modele]?.replace(/[?/]?<\w+>.*$/, "") ?? "/", droit: preset?.droit ?? `lecture de « ${libelleTable(modele)} »`,
      champs, parDefaut: preset ? [...preset.parDefaut] : sc.parDefaut,
    };
    const calcules = preset ? (preset as PresetGenerique).calcules : [];
    lireLignes = async (filtres, utiles) => {
      const besoin = new Set(calcules.flatMap((c) => c.besoin));
      const lus = [...new Set([...utiles, ...champs.filter((c) => c.chemin && besoin.has(c.chemin))])].filter((c) => c.chemin);
      const m = modeleDecrit(modele)!;
      const versPlusieurs = (r: string) => !!m.champs.find((c) => c.nom === r)?.liste;
      const clauses = filtres.map((f) => clauseDeFiltre(f, versPlusieurs)).filter((x): x is Clause => !!x);
      const vivantes = VIVANTES[modele] && !filtres.some((f) => Object.keys(VIVANTES[modele]!).includes(f.champ.chemin ?? "")) ? [VIVANTES[modele]!] : [];
      const brutes = await delegue(modele).findMany({ where: { AND: [droit.portee, ...vivantes, ...clauses] }, select: selection(modele, lus, sc.portees), take: SCAN_MAX + 1 });
      await bornerLesLiees(modele, brutes, lus, sc.portees);
      const tronque = brutes.length > SCAN_MAX;
      const lignes = brutes.slice(0, SCAN_MAX).map((b) => {
        const l = aplatir(b, lus);
        for (const c of calcules) l[c.champ.nom] = c.calcul(l, maintenant);
        l.lien = lien(modele, b);
        if ("updatedAt" in b) l.majLe = b.updatedAt;
        return l;
      });
      return { lignes, tronque };
    };
  }

  // ── Les filtres, les champs, le tri ──
  const filtres: FiltreNormalise[] = [];
  for (const f of filtresRecus(e.filtres)) {
    const n = normaliserFiltre(decl, f, maintenant);
    if ("erreur" in n) return { statut: "FILTRE_INVALIDE", vue: nomLu, raison: n.erreur, schema: schemaLong(modele, decl) };
    filtres.push(n);
  }
  const demandes = champsDemandes(decl, e.champs);
  if ("erreur" in demandes) return { statut: "CHAMP_INCONNU", vue: nomLu, raison: demandes.erreur.slice(0, 600), schema: schemaLong(modele, decl) };
  const triBrut = (e.tri && typeof e.tri === "object" ? (e.tri as Record<string, unknown>) : { champ: e.tri }) as Record<string, unknown>;
  const champTri = triBrut.champ ? trouverChamp(decl, triBrut.champ) : null;
  const sens = String(triBrut.sens ?? "").toLowerCase().startsWith("d") ? "desc" : "asc";
  const champGroupe = e.compter_par ? trouverChamp(decl, e.compter_par) : null;
  const utiles = [...new Set([...demandes.champs, ...filtres.map((f) => f.champ), ...(champTri ? [champTri] : []), ...(champGroupe ? [champGroupe] : [])])];

  const { lignes: brutes, tronque } = await lireLignes(filtres, utiles);
  const gardees = libelliser(trier(filtrer(brutes, filtres), champTri, sens), decl.champs);
  const nomJeu = texte(e, "jeu") || nomLu;
  const colonnes = [...demandes.champs, ...(gardees.some((l) => "majLe" in l) && !demandes.champs.some((c) => c.nom === "majLe") ? [{ nom: "majLe", type: "date", description: "Dernière mise à jour.", source: { regle: "updatedAt" } } as ChampVue] : [])];
  const lignes = projeter(gardees.slice(0, LIGNES_JEU_MAX), colonnes);
  const filtresAppliques = filtres.map(dire);
  jeux.inscrire({ id: nomJeu, origine: `lire ${nomLu}${filtres.length ? ` · ${filtresAppliques.join(" · ")}` : ""}`, lignes: lignes as never, masquees: [] });
  const comptes = champGroupe ? compter(gardees, champGroupe.nom) : undefined;

  if (e.compter === true || e.compter === "true") {
    const repartitions = Object.fromEntries((champGroupe ? [champGroupe] : demandes.champs.filter((c) => c.type !== "lien" && c.nom !== "id"))
      .map((c) => [c.nom, compter(gardees, c.nom)] as const).filter(([, v]) => Object.keys(v).length > 1 && Object.keys(v).length <= 30 && Object.keys(v).length < gardees.length).slice(0, 2));
    const sansFiltre: Record<string, number> = {};
    if (!gardees.length) for (const [i, f] of filtres.slice(0, 4).entries()) {
      const r = await executerVue(u, { ...e, filtres: filtresRecus(e.filtres).filter((_, j) => j !== i), compter: false, limite: 1 }, { inscrire: () => "" }, o);
      if (typeof r.total === "number") sansFiltre[dire(f)] = r.total;
    }
    const libelle = preset ? preset.nom : libelleTable(modele);
    return { statut: "COMPTE", vue: nomLu, table: modele, total: gardees.length, tronque, filtresAppliques, repartitions, ...(Object.keys(sansFiltre).length ? { sansFiltre } : {}), essai: phraseDEssai({ libelle, total: gardees.length, tronque, repartitions, sansFiltre }) };
  }

  const limite = Math.min(Math.max(Number(e.limite) || 30, 1), o.lignesMax ?? LIGNES_RENDUES_MAX);
  return {
    statut: "LU", vue: nomLu, table: modele, jeu: nomJeu, ecran: decl.ecran,
    // L'OBSERVATION de la lecture : ce que le serveur a compris du filtre, et combien de lignes il a trouvées.
    filtresAppliques, total: gardees.length, ...(tronque ? { tronque: true, attention: `plus de ${SCAN_MAX} lignes sous ces filtres : affinez (filtre sur une colonne de choix, un nombre ou une date)` } : {}),
    rendues: Math.min(limite, lignes.length), colonnes: colonnes.map((c) => c.nom),
    ...(comptes ? { comptes } : {}),
    lignes: lignes.slice(0, limite),
    ...(gardees.length > limite ? { suite: `${gardees.length - limite} ligne(s) de plus dans le jeu « ${nomJeu} » (produire, analyser_donnees)` } : {}),
  };
}

const schemaLong = (modele: string, decl: DeclarationVue) => {
  const m = modeleDecrit(modele);
  return m && !vueNommee(decl.nom) ? schemaDeTable(m, decl.champs) : `VUE ${decl.nom} — champs : ${decl.champs.map((c) => `${c.nom}${c.valeurs ? `[${Object.keys(c.valeurs).join("|")}]` : ""}`).join(", ")}.`;
};

const dire = (f: FiltreNormalise): string => {
  const v = (x: unknown) => (x && typeof x === "object" ? ("jour" in (x as object) ? (x as { jour: string }).jour : (x as { mois: string }).mois) : String(x));
  if (f.op === "vide" || f.op === "renseigne") return `${f.champ.nom} ${f.op}`;
  return `${f.champ.nom} ${f.op} ${Array.isArray(f.valeur) ? f.valeur.map(v).join(" | ") : v(f.valeur)}`;
};

function compter(lignes: readonly Ligne[], champ: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const l of lignes) for (const v of Array.isArray(l[champ]) ? (l[champ] as unknown[]) : [l[champ]]) {
    const k = v === null || v === undefined || v === "" ? "(vide)" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    c[k] = (c[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 40));
}

/** LE SCHÉMA EXPOSÉ : la règle générale (toute table), et les presets en court. */
export const DESCRIPTION_LIRE = "LIT TOUT l'ERP sous les droits de la personne. `table` : N'IMPORTE QUELLE table (modèle de l'ERP : MedicalDoctor, "
  + "MedicalInstitution, MedicalSpecialty, Task, AdministrativeRequest, PchTender, Sale, BudgetLine… ou son nom français) ; ou `vue` : un preset. "
  + "Filtres sur les colonnes ET les relations à un niveau (« institutionRef.name », « specialtyRef.name », « wilayaRef.nom ») : =, !=, contient "
  + "(sans accents ni casse), >, <, entre, parmi, vide, renseigne ; valeurs dites naturellement (« chef de service », « octobre 2026 ») : le serveur "
  + "normalise. Une faute de champ rend le schéma de la table. `compter: true` = combien (essai à blanc). Résultat : un JEU nommé (pour produire, "
  + "analyser_donnees), chaque ligne avec son lien d'écran. Presets (* = calculé par les règles de l'ERP) : " + VUES.map((v) => (estGenerique(v) ? `${v.nom}(${Object.keys(v.renomme).join(", ")}, ${v.calcules.map((c) => `${c.champ.nom}*`).join(", ")})` : schemaCourt(v as VueLisible<never>))).join(" ; ") + ".";

export function outilLire(user: CurrentUser, jeux: Pick<JeuxDuTour, "inscrire">, opts: Omit<OptionsLecture, "maintenant">): PowerTool {
  return {
    def: {
      name: OUTIL_LIRE,
      description: DESCRIPTION_LIRE,
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", description: "Une table de l'ERP (modèle ou nom français)." },
          vue: { type: "string", enum: VUES.map((v) => v.nom) },
          filtres: { type: "array", items: { type: "object", properties: { champ: { type: "string" }, op: { type: "string", description: "=, !=, contient, >, <, entre, parmi, vide…" }, valeur: { type: "string" } }, required: ["champ"] } },
          champs: { type: "array", items: { type: "string" } },
          tri: { type: "object", properties: { champ: { type: "string" }, sens: { type: "string", enum: ["asc", "desc"] } } },
          compter_par: { type: "string" },
          compter: { type: "boolean", description: "Seulement compter (essai à blanc)." },
          limite: { type: "number" },
          jeu: { type: "string" },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Données lues",
    run: async (e, u) => json(await executerVue(u, e ?? {}, jeux, opts)),
  };
}
