/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANC RÉEL DES CONNECTEURS DES CHANTIERS (lot C2, décision 0041) — sur un dépôt et un service de TEST, jamais la prod.
 *
 *   npx tsx scripts/bench/chantiers-reel.ts            tout ce que les variables permettent
 *   BANC_ETAPES=github,render npx tsx …                 seulement certaines étapes (github, routine, render)
 *
 * Ce qu'il fait, dans l'ordre :
 *   1. github   `GET /user` (compte humain ?), accès au dépôt de banc.
 *   2. routine  lance UNE session Claude Code par la routine du banc (consigne : créer `banc/<horodatage>.md` sur
 *               la branche `claude/banc-<horodatage>`, pousser, ouvrir une PR brouillon), puis lit GitHub à pas
 *               croissant : la branche produite, ses commits, la PR, les checks du SHA de tête.
 *   3. render   déploie le service de TEST (tête de sa branche), suit jusqu'au statut final, lit les journaux, puis
 *               ROLLBACK vers le déploiement sain précédent et suit jusqu'à `live`.
 *
 * GARDE-FOUS (refus net, avant tout appel qui écrit) :
 *   • DATABASE_URL doit viser localhost (la table d'idempotence `DevLancement` y est écrite) ;
 *   • le dépôt du banc ne peut pas être un dépôt de production (AMD-Internal-OS, Regulatory-Affairs, ni ceux de
 *     BANC_DEPOTS_PROTEGES) ; la routine du banc doit nommer CE dépôt (`CLAUDE_ROUTINE_<ALIAS>_DEPOT`) ;
 *   • le service Render doit être relié au dépôt du banc (`repo`) et son nom ne doit pas être protégé
 *     (BANC_SERVICES_PROTEGES, défaut : adventum-ia, amd-internal-os, erp).
 *
 * Variables : GITHUB_TOKEN, RENDER_API_KEY, BANC_DEPOT (« proprio/nom »), BANC_ROUTINE (alias), CLAUDE_ROUTINE_<ALIAS>_ID,
 * CLAUDE_ROUTINE_<ALIAS>_TOKEN, CLAUDE_ROUTINE_<ALIAS>_DEPOT (= BANC_DEPOT), BANC_SERVICE_RENDER (srv-…),
 * BANC_ATTENTE_MIN (défaut 30). Le coût : une session de l'abonnement (une seule) et deux déploiements du service de test.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { creerAgentDeveloppeur } from "@/platform/in-process/chantiers/agent-routines";
import { configRoutine, routineDuDepot } from "@/platform/dev/config";
import { construireConsigne } from "@/platform/dev/consigne";
import { creerForgeGithub } from "@/platform/in-process/chantiers/forge-github";
import { creerHebergeurRender } from "@/platform/in-process/chantiers/hebergeur-render";
import { STATUTS_DEPLOIEMENT_FINAUX, type NomDepot, type Resultat } from "@/platform/dev/ports";
import { delaiSondage } from "@/platform/in-process/chantiers/sondage";

const env = process.env;
const etapes = new Set((env.BANC_ETAPES ?? "github,routine,render").split(",").map((s) => s.trim()));
const attenteMs = Number(env.BANC_ATTENTE_MIN ?? 30) * 60_000;
const DEPOTS_PROD = [/(^|\/)AMD-Internal-OS$/i, /(^|\/)Regulatory-Affairs$/i, ...(env.BANC_DEPOTS_PROTEGES ?? "").split(",").filter(Boolean).map((d) => new RegExp(`^${d.trim().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "i"))];
const SERVICES_PROTEGES = (env.BANC_SERVICES_PROTEGES ?? "adventum-ia,amd-internal-os,erp").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...x: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...x);
function refuser(raison: string): never { console.error(`REFUS — ${raison}`); process.exit(2); }
function valeur<T>(r: Resultat<T>, quoi: string): T { if (!r.ok) refuser(`${quoi} : ${r.erreur.code} — ${r.erreur.message}`); return r.valeur; }

async function attendre<T>(quoi: string, sonde: () => Promise<T | null>): Promise<T> {
  const fin = Date.now() + attenteMs;
  for (let t = 0; Date.now() < fin; t += 1) {
    const v = await sonde();
    if (v !== null) return v;
    const d = Math.min(delaiSondage(t, { premierMs: 20_000, facteur: 1.5, maxMs: 120_000 }), Math.max(0, fin - Date.now()));
    log(`${quoi} : pas encore — prochaine sonde dans ${Math.round(d / 1000)} s`);
    await dormir(d);
  }
  return refuser(`${quoi} : rien après ${attenteMs / 60_000} min`);
}

async function main() {
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(env.DATABASE_URL ?? "")) refuser("DATABASE_URL doit viser une base LOCALE (jamais une base distante)");
  const depot = (env.BANC_DEPOT ?? "").trim() as NomDepot;
  if (!/^[\w.-]+\/[\w.-]+$/.test(depot)) refuser("BANC_DEPOT (« proprietaire/nom » d'un dépôt de TEST) est requis");
  if (DEPOTS_PROD.some((re) => re.test(depot))) refuser(`${depot} est un dépôt de production`);
  const forge = creerForgeGithub();
  const horodatage = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

  if (etapes.has("github") || etapes.has("routine")) {
    const moi = valeur(await forge.moi(), "GitHub /user");
    log(`GitHub : ${moi.login} (${moi.type})${moi.type === "User" ? "" : " — ⚠ un bot ne déclenche pas @claude"}`);
    const d = valeur(await forge.depot(depot), `GitHub ${depot}`);
    log(`dépôt ${d.nom} : branche par défaut ${d.brancheParDefaut}, écriture ${d.peutPousser}`);
  }

  if (etapes.has("routine")) {
    // BANC_ROUTINE, sinon la routine dont `_DEPOT` nomme le dépôt du banc.
    const routine = (env.BANC_ROUTINE ?? "").trim() ? configRoutine(env.BANC_ROUTINE!) : routineDuDepot(depot) ?? configRoutine("BANC");
    const alias = routine.alias;
    if (!routine.id || !routine.jeton) refuser(`routine « ${alias} » : CLAUDE_ROUTINE_${routine.alias}_ID et _TOKEN requis`);
    if (routine.depot?.toLowerCase() !== depot.toLowerCase()) refuser(`la routine ${routine.alias} doit nommer ${depot} (CLAUDE_ROUTINE_${routine.alias}_DEPOT)`);
    const branche = `claude/banc-${horodatage}`;
    const texte = construireConsigne({
      depot, branche, objectif: `Banc des connecteurs Adventum : crée le fichier banc/${horodatage}.md contenant une ligne « banc ${horodatage} ».`,
      perimetre: [`banc/${horodatage}.md`], criteres: ["le fichier existe sur la branche", "une PR brouillon est ouverte"], commandes: [],
    });
    const agent = creerAgentDeveloppeur({ forge });
    const s = valeur(await agent.lancer({ alias, texte, cleIdempotence: `banc-${horodatage}` }), "Routines API /fire");
    log(`session Claude Code : ${s.sessionUrl}`);
    const sha = await attendre(`branche ${branche}`, async () => { const r = await forge.teteDeBranche(depot, branche); return r.ok ? r.valeur : null; });
    log(`branche poussée : ${sha}`);
    const cmp = valeur(await forge.comparer(depot, valeur(await forge.depot(depot), "dépôt").brancheParDefaut, branche), "comparaison");
    log(`fichiers touchés : ${cmp.fichiers.map((f) => f.chemin).join(", ")} — hors périmètre : ${cmp.fichiers.filter((f) => f.chemin !== `banc/${horodatage}.md`).length}`);
    const pr = await attendre("PR", async () => { const r = await forge.prDeBranche(depot, branche); return r.ok ? r.valeur : null; });
    log(`PR #${pr.numero} (${pr.url}) — fusionnable : ${pr.fusionnable}`);
    const checks = valeur(await forge.checks(depot, pr.shaTete), "checks");
    log(`checks du SHA de tête : ${checks.global} (${checks.runs.length} runs)`);
  }

  if (etapes.has("render")) {
    const serviceId = (env.BANC_SERVICE_RENDER ?? "").trim();
    if (!serviceId) refuser("BANC_SERVICE_RENDER (srv-… d'un service de TEST) est requis");
    const h = creerHebergeurRender();
    const svc = valeur(await h.service(serviceId), "Render service");
    if (SERVICES_PROTEGES.includes(svc.nom.toLowerCase())) refuser(`le service ${svc.nom} est protégé`);
    if (!svc.depot || !svc.depot.toLowerCase().replace(/\.git$/, "").endsWith(`/${depot.toLowerCase()}`)) refuser(`le service ${svc.nom} n'est pas relié à ${depot} (repo : ${svc.depot ?? "aucun"})`);
    const sain = valeur(await h.deploiements(serviceId, { limite: 20 }), "liste des déploiements").find((d) => d.statut === "live" || d.statut === "deactivated");
    log(`service ${svc.nom} (${svc.type}), auto-déploiement ${svc.autoDeploy}, dernier déploiement sain : ${sain?.id ?? "aucun"}`);
    const suivre = (deployId: string) => attendre(`déploiement ${deployId}`, async () => {
      const r = await h.deploiement(serviceId, deployId);
      return r.ok && (STATUTS_DEPLOIEMENT_FINAUX as readonly string[]).includes(r.valeur.statut) ? r.valeur : null;
    });
    const lance = valeur(await h.deployer(serviceId), "déployer");
    const dep = lance ?? valeur(await h.deploiements(serviceId, { limite: 1 }), "déploiement en file")[0]!;
    const fini = await suivre(dep.id);
    log(`déploiement ${fini.id} : ${fini.statut} (${fini.sha?.slice(0, 7) ?? "?"})`);
    if (svc.proprietaireId) {
      const j = valeur(await h.journaux({ proprietaireId: svc.proprietaireId, serviceId, limite: 20 }), "journaux");
      log(`journaux : ${j.lignes.length} lignes, ${j.lignes.filter((l) => l.niveau === "error").length} en erreur`);
    }
    log(`variables (NOMS) : ${valeur(await h.nomsDesVariables(serviceId), "variables").join(", ")}`);
    if (sain && sain.id !== fini.id) {
      const rb = valeur(await h.rollback(serviceId, sain.id), "rollback");
      const apres = await suivre(rb.id);
      log(`rollback vers ${sain.id} → ${apres.id} : ${apres.statut} (l'auto-déploiement n'est PAS coupé par l'API de rollback)`);
    } else log("rollback : pas de déploiement sain antérieur distinct — sauté");
  }
  log("banc terminé");
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
