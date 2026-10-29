/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DU RÉSEAU ET DE LA CARTE (mandat 5 §40).
 *
 *   · `reseau_entreprise` — le graphe des relations : chemins entre deux entités, portée d'une
 *     décision, qui compte (quatre centralités qui ne disent pas la même chose), communautés,
 *     points de rupture. Et le TEMPS : `au` rend le réseau tel qu'il était à cette date.
 *   · `carte_territoire`  — la géographie : distances, tournée, découpage en territoires,
 *     implantation optimale, densités. La wilaya devient un point (chef-lieu), et la limite
 *     que cela impose est DITE à chaque réponse.
 *
 * Les droits sont vérifiés dans le PONT, entité par entité : un module qu'on ne voit pas ne
 * fournit aucun nœud, donc aucun chemin ne passe par lui. Le graphe n'est pas une porte dérobée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { blocTableau } from "@/lib/assistant/sandbox-tools";
import { construireViz } from "@/platform/ia/workspace/viz-block";
import { declarerProvenance, faitCalcule } from "@/platform/in-process/fabric/provenance";
import {
  type Graphe, type Lieu, auMoment, autour, barycentre, centralites, cheminsMultiples, choisirSites,
  communautes, composantes, cycles, densites, distanceKm, enveloppe, estTemporel, implantationOptimale,
  lieuxErp, nom, pointsDeRupture, portee, reseauErp, sommaire, territoires, tournee, AVERTISSEMENT_CHEF_LIEU,
  coordonneesDe,
} from "@/platform/in-process/reseau";
import { arrondi } from "@/platform/in-process/calcul";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const liste = (input: Record<string, unknown>, key: string): string[] =>
  Array.isArray(input[key]) ? (input[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

const provenance = (user: Acteur, outil: string, libelle: string, valeur: number | string, entrees: readonly string[], transformation: string, formule: string) =>
  declarerProvenance([faitCalcule({ outil, acteur: user.id, libelle, valeur, entrees, transformation, formule: formule.slice(0, 300) })]);

/** Retrouver un nœud par son identifiant complet, son identifiant nu, ou son libellé. */
function resoudre(g: Graphe, terme: string): { id: string } | { candidats: { id: string; libelle: string; type: string }[] } | null {
  const t = terme.trim();
  if (!t) return null;
  if (g.noeuds.has(t)) return { id: t };
  const plie = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const cible = plie(t);
  const exacts = [...g.noeuds.values()].filter((n) => plie(n.libelle) === cible || n.id.split(":").slice(1).join(":") === t);
  if (exacts.length === 1) return { id: exacts[0]!.id };
  if (exacts.length > 1) return { candidats: exacts.slice(0, 8).map((n) => ({ id: n.id, libelle: n.libelle, type: n.type })) };
  const partiels = [...g.noeuds.values()].filter((n) => plie(n.libelle).includes(cible) || cible.includes(plie(n.libelle)));
  if (partiels.length === 1) return { id: partiels[0]!.id };
  if (partiels.length > 1) return { candidats: partiels.slice(0, 8).map((n) => ({ id: n.id, libelle: n.libelle, type: n.type })) };
  return null;
}

/** Le bloc « réseau » rendu à l'écran : le code compose la figure depuis les arêtes du graphe. */
function blocReseau(titre: string, g: Graphe, ids: readonly string[]): Record<string, unknown> | null {
  const garde = new Set(ids);
  const lignes = g.aretes
    .filter((a) => garde.has(a.de) && garde.has(a.a))
    .slice(0, 120)
    .map((a) => ({ de: nom(g, a.de), a: nom(g, a.a), relation: a.relation }));
  if (lignes.length < 2) return null;
  const c = construireViz({ type: "graphe", de: "de", a: "a", label: "relation" }, lignes);
  if ("erreur" in c) return null;
  return { kind: "viz", title: titre, type: "graphe", donnees: c.donnees, axeYdepartZero: false, raison: "un réseau se lit en nœuds et en liens", alertes: [], note: lignes.length >= 120 ? "120 liens affichés au plus" : null };
}

/** Le bloc « carte » : des lieux avec leurs coordonnées. */
function blocCarte(titre: string, lieux: readonly Lieu[]): Record<string, unknown> | null {
  if (lieux.length < 2) return null;
  const lignes = lieux.slice(0, 300).map((l) => ({ lieu: l.libelle, lat: l.lat, lon: l.lon, poids: l.poids ?? 1 }));
  const c = construireViz({ type: "carte", label: "lieu", lat: "lat", lon: "lon", taille: "poids" }, lignes);
  if ("erreur" in c) return null;
  return { kind: "viz", title: titre, type: "carte", donnees: c.donnees, axeYdepartZero: false, raison: "des lieux se lisent sur une carte", alertes: [], note: AVERTISSEMENT_CHEF_LIEU };
}

export const RESEAU_TOOLS: PowerTool[] = [
  {
    def: {
      name: "reseau_entreprise",
      description:
        "LE RÉSEAU DES RELATIONS de l'entreprise (personnes, sociétés, produits, fournisseurs, contrats, dossiers, départements), construit depuis les liens "
        + "DÉCLARÉS dans l'ERP (« Relié à… ») et les liens STRUCTURELS des tables. "
        + "analyses : « chemin » (comment deux entités sont liées : la suite exacte des intermédiaires, et combien de chemins distincts existent) · "
        + "« portee » (ce qui dépend d'une entité, ou ce dont elle dépend, par niveau) · « qui_compte » (quatre centralités : degré = le carnet d'adresses, "
        + "PageRank = la réputation, INTERMÉDIARITÉ = le point de passage — la personne dont le départ coupe l'entreprise en deux —, proximité = l'accès) · "
        + "« communautes » (les groupes que personne n'a déclarés) · « ruptures » (qui/quoi isole le réseau s'il disparaît) · « cycles » · « sommaire ». "
        + "LE TEMPS : donner « au » (une date) rend le réseau TEL QU'IL ÉTAIT — « qui était responsable au moment de cette décision ? ». "
        + "Les droits sont appliqués entité par entité : ce que vous ne voyez pas n'existe pas dans le graphe, et les types refusés sont NOMMÉS.",
      input_schema: {
        type: "object",
        properties: {
          analyse: { type: "string", enum: ["chemin", "portee", "qui_compte", "communautes", "ruptures", "cycles", "sommaire"] },
          de: { type: "string", description: "chemin / portée : l'entité de départ (nom ou identifiant)." },
          a: { type: "string", description: "chemin : l'entité d'arrivée." },
          au: { type: "string", description: "La date à laquelle lire le réseau (AAAA-MM-JJ). Absente = aujourd'hui, tel qu'il est." },
          sens: { type: "string", enum: ["sortant", "entrant", "les_deux"], description: "portée : ce qui dépend de l'entité (sortant) ou ce dont elle dépend (entrant)." },
          relations: { type: "array", items: { type: "string" }, description: "N'utiliser que ces relations (relie_a, travaille_chez, affecte_a, porte_par, fournit, engage, signataire)." },
          types: { type: "array", items: { type: "string" }, description: "Ne garder que ces types d'entités (EMPLOYEE, COMPANY, SUPPLIER, REGULATORY_PRODUCT, LEGAL_DOCUMENT, PARTIE, DEPARTMENT…)." },
          profondeur: { type: "number", description: "portée : combien de niveaux (4 par défaut, 12 au plus)." },
          trier: { type: "string", enum: ["degre", "pagerank", "intermediarite", "proximite"], description: "qui_compte : la mesure de tri." },
          limite: { type: "number" },
          titre: { type: "string" },
        },
        required: ["analyse"],
      },
    },
    // Aucun droit propre : le PONT filtre entité par entité (`peutVoir`), donc le graphe d'une
    // personne ne contient jamais ce qu'elle n'a pas le droit de voir.
    allowed: () => true,
    label: "Réseau des relations",
    run: async (input, user) => {
      const analyse = str(input, "analyse").toLowerCase() || "sommaire";
      const titre = str(input, "titre") || "Réseau";
      const construit = await reseauErp(user, { types: liste(input, "types"), limite: num(input, "limite") });
      if ("erreur" in construit) return JSON.stringify({ ok: false, erreur: construit.erreur });
      const brut = construit.graphe;
      const dateTexte = str(input, "au");
      const quand = dateTexte ? new Date(dateTexte) : null;
      if (dateTexte && Number.isNaN(quand!.getTime())) return JSON.stringify({ ok: false, erreur: `Date « ${dateTexte} » illisible : donner AAAA-MM-JJ.` });
      const g = quand ? auMoment(brut, quand) : brut;
      const base = {
        titre,
        lu: quand ? `le réseau tel qu'il était le ${quand.toISOString().slice(0, 10)}` : "le réseau tel qu'il est aujourd'hui",
        ...(construit.typesRefuses.length ? { horsPerimetre: `Types non visibles avec vos droits, donc absents du graphe : ${construit.typesRefuses.join(", ")}.` } : {}),
        ...(construit.tronque ? { avertissement: "Lecture tronquée au plafond : le réseau montré est partiel." } : {}),
        sources: construit.sources,
      };
      const s = sommaire(g);

      if (analyse === "sommaire") {
        const parType = Object.entries(s.parType).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, entites: n }));
        return JSON.stringify({
          ok: true, ...base, noeuds: s.noeuds, liens: s.aretes, parType: s.parType, parRelation: s.parRelation,
          temporel: s.temporel, periode: s.periode, ilots: composantes(g).length,
          note: s.temporel ? "Ce réseau porte des dates : demander « au 2026-03-15 » rend son état à cette date." : "Aucun lien daté : le réseau n'a pas d'histoire lisible.",
          // UN SOMMAIRE NE PROUVE AUCUNE ABSENCE. Observé en conditions réelles : à la question
          // « comment X est-il relié à Y ? », le sommaire a été lu comme une réponse — « aucune
          // chaîne enregistrée ne les relie », alors qu'un chemin existait à deux pas. Compter
          // les nœuds et les liens ne dit rien d'un chemin entre DEUX entités précises : seule
          // l'analyse « chemin » le cherche, et elle seule peut conclure qu'il n'y en a pas.
          nePasConclure: "Ce sommaire COMPTE le réseau, il n'y cherche aucun chemin. Ne conclus JAMAIS d'ici que deux entités ne sont pas reliées : pour « comment X est-il relié à Y », rappelle cet outil avec analyse « chemin », de = X, a = Y.",
          _blocs: [blocTableau(`${titre} — entités`, parType)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, `${s.noeuds} entités, ${s.aretes} liens`, ["registre des liens", "tables ERP"], "construction du graphe sous les droits de la personne", "EntityLink + liens structurels"),
        });
      }

      if (analyse === "chemin") {
        const dep = resoudre(g, str(input, "de")), arr = resoudre(g, str(input, "a"));
        for (const [quoi, r] of [["de", dep], ["a", arr]] as const) {
          if (!r) return JSON.stringify({ ok: false, ...base, erreur: `« ${str(input, quoi)} » ne correspond à aucune entité du réseau visible.` });
          if ("candidats" in r) return JSON.stringify({ ok: false, ...base, erreur: `« ${str(input, quoi)} » est ambigu.`, candidats: r.candidats, consigne: "Demander laquelle plutôt que d'en choisir une." });
        }
        const relations = liste(input, "relations");
        const chemins = cheminsMultiples(g, (dep as { id: string }).id, (arr as { id: string }).id, { maximum: 3, orientation: "libre", ...(relations.length ? { relations } : {}) });
        if (!chemins.length) {
          return JSON.stringify({
            ok: true, ...base, lien: false,
            reponse: `Aucun chemin ne relie ${nom(g, (dep as { id: string }).id)} à ${nom(g, (arr as { id: string }).id)} dans le réseau visible.`,
            consigne: "Absence de LIEN ENREGISTRÉ, pas preuve d'absence de relation : un lien jamais saisi dans l'ERP n'existe pas ici.",
          });
        }
        const ids = [...new Set(chemins.flatMap((c) => c.noeuds))];
        return JSON.stringify({
          ok: true, ...base, lien: true, cheminsDistincts: chemins.length,
          chemins: chemins.map((c) => ({ longueur: c.longueur, recit: c.recit, etapes: c.etapes.map((e) => ({ de: nom(g, e.de), relation: e.relation, a: nom(g, e.a), note: e.note })) })),
          force: chemins.length > 1 ? `${chemins.length} chemins INDÉPENDANTS : la relation ne tient pas à un seul intermédiaire.` : "UN SEUL chemin : la relation tient entièrement à cet intermédiaire.",
          _blocs: [blocReseau(`${titre} — liaison`, g, ids)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, chemins[0]!.recit, ["registre des liens", "tables ERP"], "plus courts chemins dans le graphe des relations", `${chemins.length} chemin(s)`),
        });
      }

      if (analyse === "portee") {
        const dep = resoudre(g, str(input, "de"));
        if (!dep) return JSON.stringify({ ok: false, ...base, erreur: `« ${str(input, "de")} » ne correspond à aucune entité du réseau visible.` });
        if ("candidats" in dep) return JSON.stringify({ ok: false, ...base, erreur: "Entité ambiguë.", candidats: dep.candidats });
        const sens = (str(input, "sens") || "sortant") as "sortant" | "entrant" | "les_deux";
        const atteints = portee(g, dep.id, { sens, profondeurMax: num(input, "profondeur") ?? 4, ...(liste(input, "relations").length ? { relations: liste(input, "relations") } : {}) });
        const tab = atteints.slice(0, 60).map((x) => ({ entite: nom(g, x.id), type: g.noeuds.get(x.id)?.type ?? "", niveau: x.distance, via: x.via ? nom(g, x.via) : "—", relation: x.relation ?? "" }));
        const parNiveau: Record<string, number> = {};
        for (const x of atteints) parNiveau[`niveau ${x.distance}`] = (parNiveau[`niveau ${x.distance}`] ?? 0) + 1;
        return JSON.stringify({
          ok: true, ...base, depart: nom(g, dep.id), sens,
          total: atteints.length, parNiveau, entites: tab,
          note: sens === "sortant" ? "Ce qui DÉPEND de cette entité." : sens === "entrant" ? "Ce dont cette entité dépend." : "Tout ce qui lui est relié, dans les deux sens.",
          _blocs: [blocTableau(`${titre} — portée`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, `${atteints.length} entité(s) atteinte(s)`, ["registre des liens", "tables ERP"], `parcours en largeur (${sens})`, `depuis ${nom(g, dep.id)}`),
        });
      }

      if (analyse === "qui_compte") {
        const trier = (str(input, "trier") || "pagerank") as "degre" | "pagerank" | "intermediarite" | "proximite";
        const c = centralites(g, trier).slice(0, Math.max(5, Math.min(num(input, "limite") ?? 15, 60)));
        const tab = c.map((x) => ({ entite: x.libelle, type: x.type, liens: x.degre, réputation: arrondi(x.pagerank, 4), "point de passage": arrondi(x.intermediarite, 4), accès: arrondi(x.proximite, 3) }));
        return JSON.stringify({
          ok: true, ...base, trie: trier, entites: tab,
          lecture: "Ces quatre mesures ne disent PAS la même chose : le degré est un carnet d'adresses, l'intermédiarité est un point de passage. Une entité au degré faible et à l'intermédiarité forte est le vrai risque de rupture.",
          limite: "Une centralité mesure les liens SAISIS dans l'ERP. L'influence réelle passe aussi par des couloirs que rien n'enregistre.",
          _blocs: [blocTableau(`${titre} — qui compte`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, `${c[0]?.libelle ?? "—"} en tête (${trier})`, ["registre des liens", "tables ERP"], `centralités (degré, PageRank, Brandes, proximité), tri par ${trier}`, `${s.noeuds} nœuds`),
        });
      }

      if (analyse === "communautes") {
        const { communautes: groupes, modularite } = communautes(g);
        const tab = groupes.slice(0, 20).map((x) => ({ groupe: x.numero, libelle: x.libelle, taille: x.taille, types: x.typesDominants.join(", "), membres: x.membres.slice(0, 6).map((m) => nom(g, m)).join(", ") }));
        return JSON.stringify({
          ok: true, ...base, groupes: groupes.length, modularite: arrondi(modularite, 4),
          communautes: tab,
          lecture: modularite > 0.3
            ? "Structure NETTE : ces groupes existent vraiment dans les liens, personne ne les a déclarés."
            : `Modularité ${arrondi(modularite, 3)} : le découpage est FAIBLE — le réseau est trop uniforme pour avoir de vrais groupes.`,
          _blocs: [blocTableau(`${titre} — communautés`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, `${groupes.length} communauté(s), modularité ${arrondi(modularite, 3)}`, ["registre des liens", "tables ERP"], "détection de communautés (Louvain)", `${s.noeuds} nœuds`),
        });
      }

      if (analyse === "ruptures") {
        const points = pointsDeRupture(g).slice(0, 20);
        const tab = points.map((p) => ({ entite: nom(g, p.id), type: g.noeuds.get(p.id)?.type ?? "", "isole (entités)": p.isole.length, exemples: p.isole.slice(0, 4).map((i) => nom(g, i)).join(", ") }));
        return JSON.stringify({
          ok: true, ...base, points: points.length, ruptures: tab,
          lecture: points.length
            ? "Chacune de ces entités est le SEUL lien entre deux parties du réseau : si elle disparaît, ce qui est listé se retrouve isolé."
            : "Aucun point de rupture : chaque partie du réseau est reliée par plusieurs chemins.",
          _blocs: [blocTableau(`${titre} — points de rupture`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "reseau_entreprise", titre, `${points.length} point(s) de rupture`, ["registre des liens", "tables ERP"], "points d'articulation (Hopcroft-Tarjan)", `${s.noeuds} nœuds`),
        });
      }

      if (analyse === "cycles") {
        const trouves = cycles(g, 20);
        return JSON.stringify({
          ok: true, ...base, cycles: trouves.length,
          detail: trouves.map((c) => c.map((id) => nom(g, id)).join(" → ") + ` → ${nom(g, c[0]!)}`),
          lecture: trouves.length ? "Une dépendance circulaire est un défaut : elle rend l'ordre des choses indécidable." : "Aucune dépendance circulaire.",
          _provenance: provenance(user, "reseau_entreprise", titre, `${trouves.length} cycle(s)`, ["registre des liens", "tables ERP"], "détection de cycles", `${s.noeuds} nœuds`),
        });
      }

      void estTemporel;
      return JSON.stringify({ ok: false, erreur: `Analyse « ${analyse} » inconnue : chemin, portee, qui_compte, communautes, ruptures, cycles, sommaire.` });
    },
  },

  {
    def: {
      name: "carte_territoire",
      description:
        "LA GÉOGRAPHIE des données de l'ERP : chaque wilaya devient un point (son chef-lieu), et la limite que cela impose est DITE à chaque réponse. "
        + "analyses : « repartition » (combien et où, par wilaya, avec les densités) · « autour » (ce qu'il y a à moins de N kilomètres d'un lieu) · "
        + "« tournee » (dans quel ORDRE visiter : plus proche voisin puis 2-opt, avec le gain sur l'ordre fourni) · "
        + "« territoires » (découper entre N personnes, équilibré sur la CHARGE et non la surface) · "
        + "« implantation » (où poser un dépôt : le point qui minimise la distance pondérée, et la ville la plus proche de ce point ; "
        + "avec « candidats », le choix EXACT parmi des sites réels). "
        + "source : « medecins », « institutions » ou « contacts » — ou « lieux » pour des points fournis directement. "
        + "Ce serveur n'a NI service de routes NI géocodage d'adresse : les distances sont à vol d'oiseau (majorer d'environ 30 %) et une adresse précise ne peut pas être placée.",
      input_schema: {
        type: "object",
        properties: {
          analyse: { type: "string", enum: ["repartition", "autour", "tournee", "territoires", "implantation"] },
          source: { type: "string", enum: ["medecins", "institutions", "contacts"], description: "D'où viennent les lieux." },
          lieux: { type: "array", items: { type: "object" }, description: "Des points fournis : [{libelle, wilaya}] ou [{libelle, lat, lon, poids}]." },
          centre: { type: "string", description: "autour : la wilaya ou le lieu de référence." },
          rayonKm: { type: "number", description: "autour : le rayon en kilomètres." },
          depart: { type: "string", description: "tournee : d'où l'on part." },
          boucle: { type: "boolean", description: "tournee : revenir au point de départ (oui par défaut)." },
          nombre: { type: "number", description: "territoires : combien de territoires." },
          candidats: { type: "array", items: { type: "object" }, description: "implantation : les sites RÉELS possibles [{libelle, wilaya}] — le choix devient exact." },
          sites: { type: "number", description: "implantation : combien de sites ouvrir parmi les candidats (1 par défaut)." },
          limite: { type: "number" },
          titre: { type: "string" },
        },
        required: ["analyse"],
      },
    },
    allowed: () => true,
    label: "Carte et territoires",
    run: async (input, user) => {
      const analyse = str(input, "analyse").toLowerCase();
      const titre = str(input, "titre") || "Carte";
      // Les lieux : fournis dans l'appel, ou lus dans l'ERP sous les droits de la personne.
      let lieux: Lieu[] = [];
      let origine = "";
      let avertissement = AVERTISSEMENT_CHEF_LIEU;
      let sansCoordonnees = 0;
      const fournis = Array.isArray(input.lieux) ? (input.lieux as Record<string, unknown>[]) : [];
      if (fournis.length) {
        for (const [i, l] of fournis.entries()) {
          const libelle = String(l.libelle ?? l.nom ?? l.name ?? `lieu ${i + 1}`);
          const lat = Number(l.lat), lon = Number(l.lon);
          const poids = Number(l.poids ?? l.charge ?? 1) || 1;
          if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) { lieux.push({ id: String(l.id ?? libelle), libelle, lat, lon, poids }); continue; }
          const c = coordonneesDe(String(l.wilaya ?? l.ville ?? libelle));
          if (c) lieux.push({ id: String(l.id ?? libelle), libelle, lat: c.lat, lon: c.lon, poids, attributs: { wilaya: c.wilaya.name } });
          else sansCoordonnees += 1;
        }
        origine = `${lieux.length} lieu(x) fournis dans la conversation`;
        if (sansCoordonnees) avertissement += ` ${sansCoordonnees} lieu(x) sans wilaya reconnue : non placés.`;
      } else {
        const source = (str(input, "source") || "institutions") as "medecins" | "institutions" | "contacts";
        const r = await lieuxErp(user, source, { limite: num(input, "limite") });
        if ("erreur" in r) return JSON.stringify({ ok: false, erreur: r.erreur });
        lieux = r.lieux; origine = `${r.lieux.length} ${r.source} de l'ERP`; avertissement = r.avertissement; sansCoordonnees = r.sansCoordonnees;
      }
      if (lieux.length < 1) return JSON.stringify({ ok: false, erreur: `Aucun lieu localisable. ${avertissement}` });
      const base = { titre, source: origine, lieux: lieux.length, ...(sansCoordonnees ? { nonPlaces: sansCoordonnees } : {}), avertissement };

      if (analyse === "repartition") {
        const parWilaya = new Map<string, { n: number; poids: number }>();
        for (const l of lieux) {
          const w = String(l.attributs?.wilaya ?? "—");
          const c = parWilaya.get(w) ?? { n: 0, poids: 0 };
          c.n += 1; c.poids += l.poids ?? 1;
          parWilaya.set(w, c);
        }
        const tab = [...parWilaya.entries()].sort((a, b) => b[1].n - a[1].n).map(([wilaya, c]) => ({ wilaya, nombre: c.n, poids: arrondi(c.poids, 2) }));
        const d = densites(lieux, 5);
        const env = enveloppe(lieux);
        return JSON.stringify({
          ok: true, ...base,
          wilayas: tab.length, repartition: tab.slice(0, 60),
          concentration: d.grille.slice(0, 5).map((m) => ({ zone: `${arrondi(m.sud, 2)}–${arrondi(m.nord, 2)}° N, ${arrondi(m.ouest, 2)}–${arrondi(m.est, 2)}° E`, nombre: m.n, "par 1000 km²": arrondi(m.densiteParKm2 * 1000, 2), exemples: m.lieux.slice(0, 3).join(", ") })),
          etendueKm: env ? arrondi(env.diagonaleKm, 0) : null,
          note: d.note,
          _blocs: [blocTableau(`${titre} — par wilaya`, tab.slice(0, 30)), blocCarte(titre, lieux)].filter((b): b is Record<string, unknown> => Boolean(b)),
          _blocsDecoratifs: true,
          _provenance: provenance(user, "carte_territoire", titre, `${lieux.length} lieux dans ${tab.length} wilaya(s)`, [origine], "placement au chef-lieu de wilaya, densités par maille", "haversine"),
        });
      }

      if (analyse === "autour") {
        const c = coordonneesDe(str(input, "centre")) ?? (lieux.find((l) => l.libelle.toLowerCase().includes(str(input, "centre").toLowerCase())) ?? null);
        if (!c) return JSON.stringify({ ok: false, ...base, erreur: `« ${str(input, "centre")} » : ni une wilaya reconnue, ni un lieu de la liste.` });
        const rayon = num(input, "rayonKm") ?? 200;
        const proches = autour(c, lieux, rayon);
        const tab = proches.slice(0, 60).map((p) => ({ lieu: p.lieu.libelle, "distance (km)": arrondi(p.distanceKm, 1), direction: p.direction, wilaya: String(p.lieu.attributs?.wilaya ?? "") }));
        return JSON.stringify({
          ok: true, ...base, centre: str(input, "centre"), rayonKm: rayon, trouves: proches.length, proches: tab,
          note: "Distances à vol d'oiseau entre CHEFS-LIEUX : compter environ 30 % de plus par la route.",
          _blocs: [blocTableau(`${titre} — à moins de ${rayon} km`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "carte_territoire", titre, `${proches.length} lieu(x) à moins de ${rayon} km`, [origine], "distance orthodromique depuis le centre", "haversine"),
        });
      }

      if (analyse === "tournee") {
        const t = tournee(lieux, { depart: str(input, "depart") || undefined, boucle: input.boucle !== false });
        if ("erreur" in t) return JSON.stringify({ ok: false, ...base, erreur: t.erreur });
        const tab = t.ordre.map((l, i) => ({ étape: i + 1, lieu: l.libelle, wilaya: String(l.attributs?.wilaya ?? ""), "km depuis la précédente": i === 0 ? 0 : arrondi(distanceKm(t.ordre[i - 1]!, l), 1) }));
        return JSON.stringify({
          ok: true, ...base,
          etapes: t.ordre.length, distanceKm: arrondi(t.distanceKm, 1), distanceRoutiereEstimeeKm: arrondi(t.distanceKm * 1.3, 0),
          ordreFourniKm: arrondi(t.distanceNaiveKm, 1), gainPourcent: arrondi(t.gainPourcent, 1), boucle: t.boucle,
          ordre: tab, limites: t.limites,
          _blocs: [blocTableau(`${titre} — ordre de visite`, tab), blocCarte(`${titre} — étapes`, t.ordre)].filter((b): b is Record<string, unknown> => Boolean(b)),
          _blocsDecoratifs: true,
          _provenance: provenance(user, "carte_territoire", titre, `${arrondi(t.distanceKm, 0)} km sur ${t.ordre.length} étapes`, [origine], "plus proche voisin puis 2-opt", `gain ${arrondi(t.gainPourcent, 1)} %`),
        });
      }

      if (analyse === "territoires") {
        const r = territoires(lieux, num(input, "nombre") ?? 3);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const tab = r.territoires.map((t) => ({ territoire: t.numero, libelle: t.libelle, lieux: t.lieux.length, charge: arrondi(t.charge, 2), "rayon (km)": arrondi(t.rayonKm, 0), principales: t.lieux.slice(0, 4).map((l) => l.libelle).join(", ") }));
        return JSON.stringify({
          ok: true, ...base, territoires: r.territoires.length, equilibrePourcent: arrondi(r.equilibre * 100, 1),
          decoupage: tab,
          detail: r.territoires.map((t) => ({ numero: t.numero, centre: { lat: arrondi(t.centre.lat, 4), lon: arrondi(t.centre.lon, 4) }, lieux: t.lieux.map((l) => l.libelle) })),
          limites: r.limites,
          _blocs: [blocTableau(`${titre} — territoires`, tab), blocCarte(titre, lieux)].filter((b): b is Record<string, unknown> => Boolean(b)),
          _blocsDecoratifs: true,
          _provenance: provenance(user, "carte_territoire", titre, `${r.territoires.length} territoires, équilibre ${arrondi(r.equilibre * 100, 0)} %`, [origine], "k-moyennes sphériques puis rééquilibrage par la charge", "haversine"),
        });
      }

      if (analyse === "implantation") {
        const candidatsBruts = Array.isArray(input.candidats) ? (input.candidats as Record<string, unknown>[]) : [];
        if (candidatsBruts.length) {
          const candidats: Lieu[] = [];
          for (const [i, c] of candidatsBruts.entries()) {
            const libelle = String(c.libelle ?? c.nom ?? c.name ?? `site ${i + 1}`);
            const lat = Number(c.lat), lon = Number(c.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) { candidats.push({ id: libelle, libelle, lat, lon }); continue; }
            const w = coordonneesDe(String(c.wilaya ?? libelle));
            if (w) candidats.push({ id: libelle, libelle, lat: w.lat, lon: w.lon });
          }
          const r = choisirSites(lieux, candidats, num(input, "sites") ?? 1);
          if ("erreur" in r) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
          const tab = r.affectation.slice(0, 60).map((a) => ({ client: a.client.libelle, "site retenu": a.site.libelle, "distance (km)": arrondi(a.distanceKm, 1) }));
          return JSON.stringify({
            ok: true, ...base, methode: "choix exact parmi les sites candidats",
            sites: r.sites.map((s) => s.libelle), distanceTotaleKm: arrondi(r.distanceTotaleKm, 0),
            combinaisonsTestees: r.combinaisonsTestees, affectation: tab, limites: r.limites,
            _blocs: [blocTableau(`${titre} — affectation`, tab)].filter(Boolean), _blocsDecoratifs: true,
            _provenance: provenance(user, "carte_territoire", titre, `sites : ${r.sites.map((s) => s.libelle).join(", ")}`, [origine], "p-médian par énumération exacte", `${r.combinaisonsTestees} combinaisons`),
          });
        }
        const r = implantationOptimale(lieux);
        if ("erreur" in r) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const b = barycentre(lieux)!;
        return JSON.stringify({
          ok: true, ...base, methode: "point de Weber (minimise la distance pondérée totale)",
          point: { lat: arrondi(r.point.lat, 4), lon: arrondi(r.point.lon, 4) },
          villeLaPlusProche: r.villeLaPlusProche ? { lieu: r.villeLaPlusProche.lieu.libelle, distanceKm: arrondi(r.villeLaPlusProche.distanceKm, 1), wilaya: String(r.villeLaPlusProche.lieu.attributs?.wilaya ?? "") } : null,
          distanceMoyenneKm: arrondi(r.distanceMoyenneKm, 1), distanceMaxKm: arrondi(r.distanceMaxKm, 1),
          barycentreSimple: { lat: arrondi(b.lat, 4), lon: arrondi(b.lon, 4) },
          ecartAuBarycentreKm: arrondi(distanceKm(r.point, b), 1),
          limites: r.limites,
          consigne: "Donner « candidats » (des sites réels) transforme ce point théorique en un CHOIX exact entre des lieux qui existent.",
          _blocs: [blocCarte(titre, lieux)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "carte_territoire", titre, `${arrondi(r.point.lat, 3)}, ${arrondi(r.point.lon, 3)}`, [origine], "point de Weber (Weiszfeld)", `${r.iterations} itérations`),
        });
      }

      return JSON.stringify({ ok: false, erreur: `Analyse « ${analyse} » inconnue : repartition, autour, tournee, territoires, implantation.` });
    },
  },
];
