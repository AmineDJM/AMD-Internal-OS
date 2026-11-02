/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DES OBJECTIFS (mandat 6 §47) — ce qui survit aux missions.
 *
 * ── LA PHRASE QUE CET OUTIL EXISTE POUR DIRE ────────────────────────────────────────────
 *
 * « 78 %, le facteur négatif principal est le retard des dossiers X et Y. »
 *
 * Pas « 78 % ». Le pourcentage seul a l'air d'un résultat et n'est actionnable pour personne ;
 * il vient donc TOUJOURS avec ses facteurs, leurs preuves, et ce que le nombre n'est pas — une
 * prévision statistique. Aucun modèle n'a été ajusté ; c'est une agrégation de faits observés
 * pondérée par des poids déclarés dans le code, et le dire n'est pas de la modestie : c'est ce
 * qui permet de contester un poids au lieu de subir un chiffre.
 *
 * ── CE QUE L'OUTIL NE FAIT JAMAIS ───────────────────────────────────────────────────────
 *
 * Cocher un critère tout seul. « Le dossier est déposé » se CONSTATE, avec sa preuve. Un système
 * qui passerait un critère au vert parce qu'une mission s'est bien terminée confondrait le
 * travail fait et le résultat obtenu — et déclarerait l'objectif atteint le jour où il ne l'est
 * pas encore.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { creerObjectif, etatObjectif, listerObjectifs, majObjectif, simuler } from "@/platform/in-process/objectif";

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const liste = (input: Record<string, unknown>, key: string): unknown[] => (Array.isArray(input[key]) ? (input[key] as unknown[]) : []);
const nb = (v: unknown, defaut: number): number => (typeof v === "number" && Number.isFinite(v) ? v : defaut);
const dateOu = (s: string): Date | null => {
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T12:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

export const OBJECTIF_TOOLS: PowerTool[] = [
  {
    def: {
      name: "objectif_durable",
      description:
        "UN OBJECTIF QUI SURVIT AUX MISSIONS — « je veux qu'on soit prêts pour l'AO 2027 ». "
        + "Ce n'est PAS une mission : une mission se ferme, un objectif se surveille jusqu'à ce qu'il soit atteint. "
        + "questions : « creer » (l'objectif MOT POUR MOT, ses critères de succès, ses jalons avec leurs dépendances, ses risques) · "
        + "« etat » (où on en est ET la probabilité d'y arriver, avec le FACTEUR NÉGATIF PRINCIPAL nommé, les preuves de chaque facteur, et ce que le chiffre n'est pas) · "
        + "« lister » (les objectifs actifs, chacun avec sa probabilité) · "
        + "« constater » (mettre à jour un critère, un jalon, un risque, un lien causal — avec sa PREUVE ; rien ne se coche tout seul) · "
        + "« simuler » (« que se passe-t-il si le dossier X glisse de 2 mois ? » — propage le choc dans les dépendances causales déclarées, en multipliant les confiances). "
        + "La probabilité n'est JAMAIS une prévision statistique et ne se donne jamais seule.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["creer", "etat", "lister", "constater", "simuler"] },
          objectif: { type: "string", description: "L'identifiant de l'objectif (etat / constater / simuler)." },
          enonce: { type: "string", description: "creer : l'objectif tel que la personne l'a dit, MOT POUR MOT." },
          reformulation: { type: "string", description: "creer : la reformulation opérationnelle, si utile." },
          echeance: { type: "string", description: "L'horizon (AAAA-MM-JJ)." },
          criteres: {
            type: "array", description: "Les critères de succès. Un critère ATTEINT sans preuve est PÉNALISÉ.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, enonce: { type: "string" }, mesurable: { type: "boolean" },
                etat: { type: "string", enum: ["ATTEINT", "EN_COURS", "NON_ATTEINT", "INCONNU"] },
                preuve: { type: "string", description: "Ce qui permet d'affirmer cet état. Sans elle, c'est une opinion." },
              },
              required: ["enonce"],
            },
          },
          jalons: {
            type: "array", description: "Les jalons, avec leurs dépendances : un retard qui en bloque quatre coûte les leurs aussi.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, libelle: { type: "string" }, echeance: { type: "string" },
                etat: { type: "string", enum: ["FAIT", "EN_COURS", "EN_RETARD", "PAS_COMMENCE", "ABANDONNE"] },
                dependDe: { type: "array", items: { type: "string" } },
                proprietaire: { type: "string" }, missionId: { type: "string" },
              },
              required: ["libelle"],
            },
          },
          risques: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, quoi: { type: "string" }, vraisemblance: { type: "number" }, impact: { type: "number" }, parade: { type: "string" } },
              required: ["quoi"],
            },
          },
          liens: {
            type: "array",
            description: "Les dépendances CAUSALES (« le retard du dossier freine le packaging »). Une flèche sans preuve est traitée comme une SUPPOSITION et sa confiance est plafonnée.",
            items: {
              type: "object",
              properties: {
                de: { type: "string" }, vers: { type: "string" },
                direction: { type: "string", enum: ["RENFORCE", "FREINE"] },
                intensite: { type: "number" }, confiance: { type: "number" },
                hypothese: { type: "string", description: "L'hypothèse en toutes lettres — sans elle, personne ne pourra la contester." },
                preuves: { type: "array", items: { type: "string" } },
              },
              required: ["de", "vers"],
            },
          },
          etat_objectif: { type: "string", enum: ["ACTIF", "ATTEINT", "COMPROMIS", "ABANDONNE"], description: "constater : changer l'état de l'objectif lui-même." },
          mission: { type: "string", description: "constater : rattacher une mission lancée POUR cet objectif." },
          noeud: { type: "string", description: "simuler : le nœud qui bouge." },
          ampleur: { type: "number", description: "simuler : de combien (1 = un choc plein)." },
          tous: { type: "boolean", description: "lister : inclure les objectifs non actifs." },
        },
        required: ["question"],
      },
    },
    // Aucun droit propre : le PONT réserve les objectifs au siège exécutif et cloisonne PAR
    // REQUÊTE sur `ownerId` — un identifiant deviné ne donne accès à rien.
    allowed: () => true,
    label: "Objectif durable",
    run: async (input, user) => {
      const question = str(input, "question").toLowerCase() || "lister";

      if (question === "creer") {
        const r = await creerObjectif(user, {
          enonce: str(input, "enonce"),
          reformulation: str(input, "reformulation") || null,
          horizon: dateOu(str(input, "echeance")),
          criteres: liste(input, "criteres"), jalons: liste(input, "jalons"),
          risques: liste(input, "risques"), liens: liste(input, "liens"),
        });
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, objectif: r.id,
          note: "L'objectif est enregistré. Il ne se ferme pas tout seul : aucun critère ne passera à ATTEINT sans que quelqu'un le CONSTATE, avec sa preuve.",
        });
      }

      if (question === "lister") {
        const r = await listerObjectifs(user, { actifsSeulement: input.tous !== true });
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true,
          objectifs: r.objectifs.map(({ objectif, estimation, avancement }) => ({
            id: objectif.id, enonce: objectif.enonce, etat: objectif.etat, echeance: jour(objectif.echeance),
            probabilite: estimation.phrase,
            avancement: `${avancement.criteresAtteints}/${avancement.criteresTotal} critère(s), ${avancement.jalonsFaits}/${avancement.jalonsTotal} jalon(s)`,
            en_retard: avancement.jalonsEnRetard.length,
          })),
        });
      }

      const id = str(input, "objectif");
      if (!id) return JSON.stringify({ ok: false, erreur: "Précisez l'objectif (son identifiant)." });

      if (question === "constater") {
        const r = await majObjectif(user, id, {
          ...(liste(input, "criteres").length ? { criteres: liste(input, "criteres") } : {}),
          ...(liste(input, "jalons").length ? { jalons: liste(input, "jalons") } : {}),
          ...(liste(input, "risques").length ? { risques: liste(input, "risques") } : {}),
          ...(liste(input, "liens").length ? { liens: liste(input, "liens") } : {}),
          ...(str(input, "etat_objectif") ? { etat: str(input, "etat_objectif") } : {}),
          ...(str(input, "echeance") ? { horizon: dateOu(str(input, "echeance")) } : {}),
          ...(str(input, "mission") ? { missionId: str(input, "mission") } : {}),
        });
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({ ok: true, note: "Constaté. Relis l'état pour voir l'effet sur la probabilité." });
      }

      if (question === "simuler") {
        const noeud = str(input, "noeud");
        if (!noeud) return JSON.stringify({ ok: false, erreur: "Précisez le nœud qui bouge (`noeud`)." });
        const r = await simuler(user, id, { noeud, ampleur: nb(input.ampleur, 1) });
        if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
        return JSON.stringify({
          ok: true, choc: noeud,
          impacts: r.impacts.map((i) => ({
            sur: i.noeud, effet: Math.round(i.effet * 100) / 100,
            confiance: Math.round(i.confiance * 100) / 100,
            chemin: i.chemin.join(" → "),
            ...(i.traverseUneSupposition ? { avertissement: "ce chemin passe par une hypothèse NON étayée : l'ampleur est indicative" } : {}),
          })),
          chemins: r.chemins,
          hypotheses_sans_preuve: r.audit.suppositions.map((l) => `${l.de} → ${l.vers}`),
          ...(r.audit.cycles.length ? { cycles: r.audit.cycles.map((c) => c.join(" → ")) } : {}),
          lecture: "Ces effets sont des ORDRES DE GRANDEUR issus d'hypothèses déclarées, pas une simulation validée. Regarde la CONFIANCE avant l'ampleur.",
        });
      }

      // ── etat ────────────────────────────────────────────────────────────────────────
      const r = await etatObjectif(user, id);
      if ("erreur" in r) return JSON.stringify({ ok: false, ...r });
      return JSON.stringify({
        ok: true,
        objectif: r.objectif.enonce,
        etat: r.objectif.etat,
        echeance: jour(r.objectif.echeance),
        jours_restants: r.avancement.joursRestants,
        // LA PHRASE DU MANDAT : le pourcentage ET le facteur négatif principal.
        probabilite: r.estimation.phrase,
        facteurs: r.estimation.facteurs.map((f) => ({ quoi: f.quoi, effet_points: Math.round(f.effet * 10) / 10, preuve: f.preuve })),
        confiance_dans_l_estimation: Math.round(r.estimation.confiance * 100) / 100,
        ce_que_ce_chiffre_n_est_pas: r.estimation.limites,
        criteres: r.objectif.criteres.map((c) => ({ enonce: c.enonce, etat: c.etat, preuve: c.preuve ?? "AUCUNE PREUVE" })),
        jalons_en_retard: r.avancement.jalonsEnRetard.map((j) => ({ libelle: j.libelle, echeance: jour(j.echeance) })),
        jalons_bloques: r.avancement.jalonsBloques.map((b) => `${b.jalon.libelle} ← bloqué par ${b.par.map((p) => p.libelle).join(", ")}`),
        critères_atteints_sans_preuve: r.avancement.sansPreuve.map((c) => c.enonce),
        missions_liees: r.objectif.missions,
        dependances_causales: {
          liens: r.causal.liens.map((l) => `${l.de} ${l.direction === "FREINE" ? "freine" : "renforce"} ${l.vers} (confiance ${l.confiance})`),
          sans_hypothese_ecrite: r.causal.audit.sansHypothese.map((l) => `${l.de} → ${l.vers}`),
          suppositions: r.causal.audit.suppositions.map((l) => `${l.de} → ${l.vers}`),
        },
      });
    },
  },
];
