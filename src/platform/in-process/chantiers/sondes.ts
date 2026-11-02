import { aliasDeRoutines, configGithub, configMimo, configRender, configRoutine, jetonRelais, type Env } from "@/platform/dev/config";
import { creerForgeGithub } from "./forge-github";
import { creerHebergeurRender } from "./hebergeur-render";
import { appeler, type ConfigHttp } from "@/platform/dev/http";
import { quotasRoutine } from "./lancements";
import { etatDuRelais } from "./relais";
import type { EtatConnecteur } from "@/platform/dev/ports";

/**
 * LES SONDES DE L'ÉCRAN Administration › Développement (lot C2) — SANS action destructive, en lecture seule :
 *
 *   GitHub   `GET /user` (le compte doit être HUMAIN : un bot ne déclenche pas `@claude`) puis `GET /repos/{dépôt}`
 *            pour chaque dépôt de `CHANTIERS_DEPOTS` (accès et droit de pousser) ; quota `x-ratelimit-remaining`.
 *   Render   `GET /services` ; quota `RateLimit-Remaining`.
 *   Routines aucune sonde « à vide » n'est documentée (un appel à `/fire` LANCE une session) : configurée ou non, et
 *            les quotas comptés par Adventum (30/h/routine, 100/h/compte).
 *   MiMo     `GET <MIMO_BASE_URL>/models` avec la clé `mimo` : la liste des modèles disponibles.
 *
 * Jamais une valeur secrète à l'écran : les NOMS des variables, posées ou non.
 */

const nomsPoses = (env: Env, noms: string[]) => noms.map((nom) => ({ nom, posee: Boolean((env[nom] ?? "").trim()) }));

export interface OptionsSondes { env?: Env; fetch?: typeof fetch }

export async function sonderGithub(opts: OptionsSondes = {}): Promise<EtatConnecteur> {
  const env = opts.env ?? process.env;
  const conf = configGithub(env);
  const etat: EtatConnecteur = {
    connecteur: "github", configure: Boolean(conf.jeton), joignable: null,
    variables: nomsPoses(env, ["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "CHANTIERS_DEPOTS"]), quotas: [], details: [],
  };
  if (!conf.jeton) return etat;
  const forge = creerForgeGithub({ env, fetch: opts.fetch });
  const moi = await forge.moi();
  etat.joignable = moi.ok;
  if (!moi.ok) { etat.erreur = moi.erreur.message; return etat; }
  etat.details.push(`compte : ${moi.valeur.login} (${moi.valeur.type})${moi.valeur.type === "User" ? "" : " — ⚠ un compte non humain ne déclenche pas @claude"}`);
  for (const depot of conf.depots) {
    const d = await forge.depot(depot);
    etat.details.push(d.ok ? `${d.valeur.nom} : accès ${d.valeur.peutPousser === false ? "lecture seule ⚠" : "en écriture"}, branche par défaut ${d.valeur.brancheParDefaut}${d.valeur.archive ? ", archivé ⚠" : ""}` : `${depot} : ${d.erreur.message}`);
  }
  if (!conf.depots.length) etat.details.push("aucun dépôt listé dans CHANTIERS_DEPOTS");
  const q = forge.quota();
  etat.quotas.push({ libelle: "requêtes API / heure", restant: q.restant, limite: q.limite, reinitialiseA: q.reinitialiseA });
  return etat;
}

export async function sonderRender(opts: OptionsSondes = {}): Promise<EtatConnecteur> {
  const env = opts.env ?? process.env;
  const conf = configRender(env);
  const etat: EtatConnecteur = {
    connecteur: "render", configure: Boolean(conf.jeton), joignable: null,
    variables: nomsPoses(env, ["RENDER_API_KEY", "RENDER_WEBHOOK_SECRET"]), quotas: [], details: [],
  };
  if (!conf.jeton) return etat;
  const h = creerHebergeurRender({ env, fetch: opts.fetch });
  const r = await h.services();
  etat.joignable = r.ok;
  if (!r.ok) { etat.erreur = r.erreur.message; return etat; }
  for (const s of r.valeur.slice(0, 20)) {
    etat.details.push(`${s.nom} (${s.type}) — ${s.branche ?? "?"}, auto-déploiement ${s.autoDeploy ?? "?"}${s.suspendu ? ", suspendu" : ""}`);
  }
  if (!r.valeur.length) etat.details.push("aucun service visible avec cette clé");
  const q = h.quota();
  etat.quotas.push({ libelle: "requêtes API (fenêtre Render)", restant: q.restant, limite: q.limite });
  return etat;
}

export async function sonderRoutines(opts: OptionsSondes = {}): Promise<EtatConnecteur> {
  const env = opts.env ?? process.env;
  const alias = aliasDeRoutines(env);
  const etat: EtatConnecteur = {
    connecteur: "claude-code", configure: false, joignable: null,
    variables: alias.length ? alias.flatMap((a) => nomsPoses(env, [`CLAUDE_ROUTINE_${a}_ID`, `CLAUDE_ROUTINE_${a}_TOKEN`, `CLAUDE_ROUTINE_${a}_DEPOT`])) : [{ nom: "CLAUDE_ROUTINE_<ALIAS>_ID / _TOKEN / _DEPOT", posee: false }],
    quotas: [], details: [],
  };
  for (const a of alias) {
    const r = configRoutine(a, env);
    const complete = Boolean(r.id && r.jeton);
    etat.configure ||= complete;
    etat.details.push(`routine ${a} : ${complete ? "configurée" : "incomplète (ID et TOKEN requis)"}${r.depot ? ` → ${r.depot}` : " — dépôt non nommé"}`);
    const q = await quotasRoutine(a);
    etat.quotas.push({ libelle: `routine ${a} (lancements / heure)`, restant: q.routine.limite - q.routine.utilises, limite: q.routine.limite });
    if (a === alias[alias.length - 1]) etat.quotas.push({ libelle: "compte (lancements / heure)", restant: q.compte.limite - q.compte.utilises, limite: q.compte.limite });
  }
  etat.details.push("joignabilité : aucune sonde sans effet n'est documentée — un appel à /fire lance une session");
  return etat;
}

/** Le relais CLI : rien n'est sondé chez lui (c'est LUI qui tire) — on lit son dernier battement et ce qu'il a déclaré. */
export async function sonderRelais(opts: OptionsSondes = {}): Promise<EtatConnecteur> {
  const env = opts.env ?? process.env;
  const r = await etatDuRelais();
  const etat: EtatConnecteur = {
    connecteur: "relais", configure: Boolean(jetonRelais(env)), joignable: r.vuLe ? r.vivant : null,
    variables: nomsPoses(env, ["CLAUDE_RELAIS_TOKEN"]), quotas: [], details: [],
  };
  etat.details.push(r.vuLe ? `vu il y a ${Math.round((Date.now() - r.vuLe.getTime()) / 1000)} s` : "jamais vu : service Render « claude-relais » non créé ou arrêté (Blueprint › Sync, puis CLAUDE_RELAIS_TOKEN, ERP_URL, GITHUB_TOKEN)");
  if (r.version) etat.details.push(`claude : ${r.version}`);
  if (r.vuLe) etat.details.push(`relais connecté à claude.ai : ${r.connecte === null ? "inconnu" : r.connecte ? "oui" : `NON (${r.authMethod ?? "aucune"}) — les chantiers attendent : Render › claude-relais › Shell › « claude auth login », ouvrir l'URL affichée, se connecter, coller le code`}`);
  etat.details.push(`ordres en file : ${r.enAttente}${r.incertains ? ` — ${r.incertains} incertain(s) sur 7 jours, à vérifier sur claude.ai/code` : ""}`);
  return etat;
}

export async function sonderMimo(opts: OptionsSondes = {}): Promise<EtatConnecteur> {
  const env = opts.env ?? process.env;
  const conf = configMimo(env);
  const etat: EtatConnecteur = {
    connecteur: "mimo", configure: Boolean(conf.cle), joignable: null,
    variables: [...nomsPoses(env, ["mimo"]), ...nomsPoses(env, ["MIMO_BASE_URL"])], quotas: [], details: [`base : ${conf.base}`],
  };
  if (!conf.cle) return etat;
  const cfg: ConfigHttp = { fournisseur: "MiMo", base: conf.base, autorisation: `Bearer ${conf.cle}`, fetch: opts.fetch, delaiMs: 15_000 };
  const r = await appeler<{ data?: { id?: unknown }[] }>(cfg, "GET", "/models");
  etat.joignable = r.ok;
  if (!r.ok) { etat.erreur = r.erreur.message; return etat; }
  const modeles = (r.valeur.corps?.data ?? []).map((m) => (typeof m.id === "string" ? m.id : null)).filter((m): m is string => Boolean(m));
  etat.details.push(modeles.length ? `modèles : ${modeles.join(", ")}` : "réponse sans liste de modèles");
  return etat;
}

/** Les cinq sondes, en parallèle ; une sonde qui tombe n'emporte pas les autres. */
export async function etatDesConnecteurs(opts: OptionsSondes = {}): Promise<EtatConnecteur[]> {
  const sondes = [sonderRoutines, sonderRelais, sonderGithub, sonderRender, sonderMimo];
  const noms: EtatConnecteur["connecteur"][] = ["claude-code", "relais", "github", "render", "mimo"];
  const r = await Promise.allSettled(sondes.map((f) => f(opts)));
  return r.map((x, i) => (x.status === "fulfilled" ? x.value : { connecteur: noms[i]!, configure: false, joignable: false, variables: [], quotas: [], details: [], erreur: "sonde en échec" }));
}
