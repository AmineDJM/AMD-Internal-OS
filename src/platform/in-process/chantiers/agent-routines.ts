import { noterEffetExterne } from "@/lib/effets/magasin";
import { aliasDeRoutines, baseRoutines, configRoutine, type Env } from "@/platform/dev/config";
import { appeler, echec, masquer, type ConfigHttp } from "@/platform/dev/http";
import { conclure, quotasRoutine, reclamer, type LigneLancement } from "./lancements";
import type { AgentDeveloppeur, DemandeLancement, DemandeRelancePr, ErreurConnecteur, ForgeGit, MoyenAgent, Resultat, SessionLancee } from "@/platform/dev/ports";

/**
 * L'AGENT DÉVELOPPEUR — Claude Code Cloud par ses mécanismes OFFICIELS (lot C2, décision 0041).
 *
 *   lancer          Routines API : `POST {base}/v1/claude_code/routines/{trig_…}/fire`, `Authorization: Bearer <jeton de
 *                   la routine>`, `anthropic-version: 2023-06-01`, corps `{ text }` ≤ 65 536 caractères ; réponse
 *                   `{ type: "routine_fire", claude_code_session_id, claude_code_session_url }`. Vérifié le 01/11/2026 sur
 *                   platform.claude.com/docs/en/api/claude-code/routines-fire et code.claude.com/docs/en/routines.
 *   relancerDansPr  un commentaire `@claude …` sur la PR, posté avec le jeton GitHub de la Direction (compte humain à
 *                   droit d'écriture) ; la GitHub Action `anthropics/claude-code-action` (secret
 *                   `CLAUDE_CODE_OAUTH_TOKEN` CÔTÉ GITHUB) le traite dans le fil — c'est le fil qui porte le contexte.
 *
 * Reprendre une session EXISTANTE de l'abonnement n'est pas possible depuis un serveur (seule la CLI connectée au
 * compte claude.ai le fait, et l'en sortir est interdit) : la continuité passe par la branche et la PR.
 *
 * Le texte arrive dans la session ENVELOPPÉ dans un bloc `<routine-fire-payload>` marqué « donnée non fiable » : la
 * routine créée par la Direction doit dire, dans son propre prompt, d'exécuter la consigne de ce bloc (modèle dans la
 * décision 0041).
 *
 * Aucun réessai sur un délai dépassé : l'API n'a pas d'idempotence, un réessai ferait une seconde session. Seule une
 * requête certainement NON partie (DNS, connexion refusée) est rejouée, deux fois au plus.
 */

export const VERSION_ANTHROPIC = "2023-06-01";
export const BETA_ROUTINES = "experimental-cc-routine-2026-04-01";
export const TEXTE_MAX = 65_536;
const PAUSES_AVANT_ENVOI_MS = [400, 1_500];

interface ReponseFire { type?: string; claude_code_session_id?: string; claude_code_session_url?: string }

export interface OptionsAgent {
  env?: Env;
  fetch?: typeof fetch;
  /** Le port GitHub, pour `relancerDansPr`. */
  forge?: ForgeGit | null;
  /** Les pauses entre réessais AVANT envoi (les bancs les mettent à zéro). */
  pausesMs?: readonly number[];
  /** Le délai d'un appel à `/fire` (défaut 30 s) ; au-delà, l'issue est `INCERTAIN`. */
  delaiMs?: number;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sessionDeLigne(moyen: MoyenAgent, cle: string, l: LigneLancement): Resultat<SessionLancee> {
  if (l.statut === "LANCE") {
    const commentaireId = l.commentaireId ? Number(l.commentaireId) : null;
    return { ok: true, valeur: { moyen, sessionId: l.sessionId, sessionUrl: l.sessionUrl, commentaireId, commentaireUrl: moyen === "COMMENTAIRE_PR" ? l.sessionUrl : null, deja: true, cleIdempotence: cle } };
  }
  return {
    ok: false,
    erreur: {
      code: "INCERTAIN",
      message: l.statut === "EN_COURS"
        ? "un lancement avec cette clé est en cours : attendre son issue"
        : `un lancement avec cette clé a peut-être créé une session (${l.erreur ?? "issue inconnue"}) : vérifier sur claude.ai/code avant de relancer avec une nouvelle clé`,
      reessayable: false,
    },
  };
}

/** Le statut à inscrire selon l'erreur : `INCERTAIN` dès que la session a pu être créée. */
function statutApresErreur(e: ErreurConnecteur): "ECHEC" | "INCERTAIN" {
  if (e.code === "INCERTAIN") return "INCERTAIN";
  // 500 : la doc conseille de réessayer, mais sans idempotence une session a pu naître — prudence, un humain vérifie.
  if (e.code === "INDISPONIBLE" && e.statut === 500) return "INCERTAIN";
  return "ECHEC";
}

export function creerAgentDeveloppeur(opts: OptionsAgent = {}): AgentDeveloppeur {
  const env = opts.env ?? process.env;
  const pauses = opts.pausesMs ?? PAUSES_AVANT_ENVOI_MS;

  async function fire(cfg: ConfigHttp, chemin: string, texte: string): Promise<Resultat<{ sessionId: string; sessionUrl: string }>> {
    for (let essai = 0; ; essai += 1) {
      const r = await appeler<ReponseFire>(cfg, "POST", chemin, { corps: { text: texte } });
      if (r.ok) {
        const c = r.valeur.corps;
        if (c?.type === "routine_fire" && typeof c.claude_code_session_id === "string") {
          return { ok: true, valeur: { sessionId: c.claude_code_session_id, sessionUrl: c.claude_code_session_url ?? `https://claude.ai/code/${c.claude_code_session_id}` } };
        }
        return echec("INCERTAIN", "Routines API : réponse 200 illisible — une session a pu être créée");
      }
      if (r.erreur.code !== "RESEAU" || essai >= pauses.length) return r;
      await dormir(pauses[essai]!);
    }
  }

  return {
    routines: () => aliasDeRoutines(env),

    async lancer(d: DemandeLancement): Promise<Resultat<SessionLancee>> {
      const routine = configRoutine(d.alias, env);
      if (!routine.id || !routine.jeton) {
        return echec("NON_CONFIGURE", `routine « ${routine.alias} » : CLAUDE_ROUTINE_${routine.alias}_ID et _TOKEN sont requis`);
      }
      if (!d.texte.trim()) return echec("INVALIDE", "consigne vide");
      if (d.texte.length > TEXTE_MAX) return echec("INVALIDE", `consigne de ${d.texte.length} caractères (maximum ${TEXTE_MAX})`);
      if (!d.cleIdempotence.trim()) return echec("INVALIDE", "clé d'idempotence requise");

      const quotas = await quotasRoutine(routine.alias);
      if (quotas.libreDansMs !== null) {
        return { ok: false, erreur: { code: "QUOTA", message: `quota horaire atteint (routine ${quotas.routine.utilises}/${quotas.routine.limite}, compte ${quotas.compte.utilises}/${quotas.compte.limite})`, reessayable: true, reessayerApresMs: quotas.libreDansMs } };
      }
      // J7 : en simulation, le lancement est noté et neutralisé — rien ne sort, rien n'est réclamé.
      if (noterEffetExterne({ acte: "ECRITURE_EXTERNE", cible: `Claude Code : routine ${routine.alias}`, apercu: d.texte.slice(0, 160), origine: "chantiers" })) {
        return echec("SIMULE", "simulation : la session Claude Code n'a pas été lancée");
      }
      const rec = await reclamer({ cle: d.cleIdempotence, moyen: "ROUTINE", cible: routine.alias, missionId: d.missionId, texte: d.texte });
      if (rec.etat === "DEJA") return sessionDeLigne("ROUTINE", d.cleIdempotence, rec.ligne);

      const cfg: ConfigHttp = {
        fournisseur: "Routines API",
        base: baseRoutines(env),
        autorisation: `Bearer ${routine.jeton}`,
        entetes: { "anthropic-version": VERSION_ANTHROPIC, "anthropic-beta": BETA_ROUTINES },
        fetch: opts.fetch,
        delaiMs: opts.delaiMs ?? 30_000,
      };
      const r = await fire(cfg, `/v1/claude_code/routines/${encodeURIComponent(routine.id)}/fire`, d.texte);
      if (!r.ok) {
        await conclure(rec.id, { statut: statutApresErreur(r.erreur), erreur: masquer(r.erreur.message, [routine.jeton]) });
        return r;
      }
      await conclure(rec.id, { statut: "LANCE", sessionId: r.valeur.sessionId, sessionUrl: r.valeur.sessionUrl });
      return { ok: true, valeur: { moyen: "ROUTINE", sessionId: r.valeur.sessionId, sessionUrl: r.valeur.sessionUrl, deja: false, cleIdempotence: d.cleIdempotence } };
    },

    async relancerDansPr(d: DemandeRelancePr): Promise<Resultat<SessionLancee>> {
      if (!opts.forge) return echec("NON_CONFIGURE", "GitHub : GITHUB_TOKEN requis pour commenter la PR");
      const corps = `@claude ${d.texte.trim()}`;
      if (corps.length > TEXTE_MAX) return echec("INVALIDE", `commentaire de ${corps.length} caractères (maximum ${TEXTE_MAX})`);
      if (!d.cleIdempotence.trim()) return echec("INVALIDE", "clé d'idempotence requise");
      // J7 : l'écriture est notée (et neutralisée en simulation) par la forge elle-même — `SIMULE` remonte alors ici.
      const rec = await reclamer({ cle: d.cleIdempotence, moyen: "COMMENTAIRE_PR", cible: d.depot, missionId: d.missionId, texte: corps });
      if (rec.etat === "DEJA") return sessionDeLigne("COMMENTAIRE_PR", d.cleIdempotence, rec.ligne);
      const r = await opts.forge.commenterPr(d.depot, d.numeroPr, corps);
      if (!r.ok) {
        await conclure(rec.id, { statut: statutApresErreur(r.erreur), erreur: r.erreur.message });
        return r;
      }
      await conclure(rec.id, { statut: "LANCE", sessionUrl: r.valeur.url, commentaireId: String(r.valeur.id) });
      return { ok: true, valeur: { moyen: "COMMENTAIRE_PR", sessionId: null, sessionUrl: null, commentaireId: r.valeur.id, commentaireUrl: r.valeur.url, deja: false, cleIdempotence: d.cleIdempotence } };
    },
  };
}
