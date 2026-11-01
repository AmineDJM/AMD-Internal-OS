import { createHmac, timingSafeEqual } from "node:crypto";
import type { FaitDev, NomDepot } from "./ports";

/**
 * LES WEBHOOKS ENTRANTS DES CHANTIERS (lot C2) — vérifier, puis ramener à des `FaitDev`. Aucune base ici.
 *
 * GitHub  `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 du corps BRUT sous `GITHUB_WEBHOOK_SECRET`
 *         (docs.github.com « Validating webhook deliveries ») ; `X-GitHub-Delivery` (GUID de livraison) ;
 *         `X-GitHub-Event`. Événements suivis : push, pull_request, check_suite, check_run, workflow_run, issue_comment.
 * Render  Standard Webhooks (render.com/docs/webhooks) : en-têtes `webhook-id` (`evt-…`, stable d'un réessai à
 *         l'autre), `webhook-timestamp` (secondes), `webhook-signature: v1,<base64>` (plusieurs, séparées par des
 *         espaces) ; HMAC-SHA256 de `id.timestamp.corps`. La clé est le « signing secret » du webhook : décodé en
 *         base64 après `whsec_` (convention Standard Webhooks), sinon pris tel quel — les deux sont essayés, en temps
 *         constant. Horodatage à ± 5 minutes, contre le rejeu.
 *
 * La CLÉ d'un fait est sémantique (`push:<dépôt>:<branche>:<sha>`…) : le même fait vu par le sondage de secours a la
 * même clé, donc un seul `BusinessEvent`.
 */

export const TOLERANCE_HORODATAGE_S = 300;

function egal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifierSignatureGithub(corpsBrut: string, signature: string | null, secret: string | null): boolean {
  if (!secret || !signature || !signature.startsWith("sha256=")) return false;
  const attendu = createHmac("sha256", secret).update(corpsBrut, "utf8").digest();
  const recu = Buffer.from(signature.slice(7).trim(), "hex");
  return egal(attendu, recu);
}

/** Les clés candidates d'un secret Standard Webhooks (`whsec_<base64>` décodé, et le texte tel quel). */
function clesStandard(secret: string): Buffer[] {
  const cles = [Buffer.from(secret, "utf8")];
  if (secret.startsWith("whsec_")) {
    const b = Buffer.from(secret.slice(6), "base64");
    if (b.length) cles.unshift(b);
  }
  return cles;
}

export interface EntetesStandard { id: string | null; horodatage: string | null; signature: string | null }

export function verifierSignatureRender(corpsBrut: string, h: EntetesStandard, secret: string | null, maintenantS = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !h.id || !h.horodatage || !h.signature) return false;
  if (!/^\d+$/.test(h.horodatage) || Math.abs(maintenantS - Number(h.horodatage)) > TOLERANCE_HORODATAGE_S) return false;
  const message = `${h.id}.${h.horodatage}.${corpsBrut}`;
  const recues = h.signature.split(" ").map((x) => x.trim()).filter((x) => x.startsWith("v1,")).map((x) => Buffer.from(x.slice(3), "base64"));
  return clesStandard(secret).some((cle) => {
    const attendu = createHmac("sha256", cle).update(message, "utf8").digest();
    return recues.some((r) => egal(attendu, r));
  });
}

/** La signature qu'un émetteur Standard Webhooks pose — pour les bancs et les tests. */
export function signerStandard(corpsBrut: string, id: string, horodatage: string, secret: string): string {
  return `v1,${createHmac("sha256", clesStandard(secret)[0]!).update(`${id}.${horodatage}.${corpsBrut}`, "utf8").digest("base64")}`;
}

// ─────────────────────────────── NORMALISATION ───────────────────────────────

interface Brut { [k: string]: unknown }
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
const o = (v: unknown): Brut => (v && typeof v === "object" ? (v as Brut) : {});

const vide = (f: Pick<FaitDev, "type" | "fournisseur" | "cle" | "brut">): FaitDev => ({
  ...f, depot: null, branche: null, sha: null, numeroPr: null, serviceId: null, deployId: null, statut: null, auteur: null, url: null, survenuLe: null,
});

/** La clé d'un fait « checks terminés » — partagée avec le sondage (`sondage.ts`). */
export const cleChecks = (depot: string, sha: string, conclusion: string) => `checks:${depot}:${sha}:${conclusion}`;
export const clePush = (depot: string, branche: string, sha: string) => `push:${depot}:${branche}:${sha}`;
export const cleDeploiement = (deployId: string, statut: string) => `render:deploy:${deployId}:${statut}`;

/** Le statut d'un déploiement Render ramené au vocabulaire des webhooks (`succeeded` / `failed` / `canceled`). */
export function statutFinalRender(statut: string): "succeeded" | "failed" | "canceled" | null {
  if (statut === "live" || statut === "succeeded") return "succeeded";
  if (statut === "canceled") return "canceled";
  if (/failed$/.test(statut)) return "failed";
  return null;
}

/** UN corps GitHub → zéro ou un fait. Un événement non suivi (ping, étoile…) ne rend rien. */
export function faitsGithub(evenement: string, corps: Brut): FaitDev[] {
  const depot = s(o(corps.repository).full_name) as NomDepot | null;
  if (!depot) return [];
  const action = s(corps.action);
  const auteur = s(o(corps.sender).login);
  if (evenement === "push") {
    const ref = s(corps.ref) ?? "";
    const sha = s(corps.after);
    if (!ref.startsWith("refs/heads/") || !sha || corps.deleted === true) return [];
    const branche = ref.slice(11);
    return [{ ...vide({ type: "DEV_PUSH", fournisseur: "github", cle: clePush(depot, branche, sha), brut: "push" }), depot, branche, sha, auteur, url: s(corps.compare), survenuLe: s(o(corps.head_commit).timestamp) }];
  }
  if (evenement === "pull_request") {
    const pr = o(corps.pull_request);
    const numero = n(pr.number);
    if (!numero || !action) return [];
    const statut = action === "closed" && pr.merged === true ? "merged" : action;
    const sha = s(o(pr.head).sha);
    return [{ ...vide({ type: "DEV_PR", fournisseur: "github", cle: `pr:${depot}#${numero}:${statut}:${sha ?? ""}`, brut: `pull_request.${action}` }), depot, branche: s(o(pr.head).ref), sha, numeroPr: numero, statut, auteur, url: s(pr.html_url), survenuLe: s(pr.updated_at) }];
  }
  if (evenement === "check_suite" || evenement === "check_run") {
    const c = o(corps[evenement]);
    if (action !== "completed") return [];
    const sha = s(c.head_sha);
    const conclusion = s(c.conclusion) ?? "inconnue";
    if (!sha) return [];
    const branche = s(c.head_branch) ?? s(o(o(c.check_suite)).head_branch);
    const prs = Array.isArray(c.pull_requests) ? c.pull_requests.map(o) : [];
    return [{ ...vide({ type: "DEV_CHECKS", fournisseur: "github", cle: `${cleChecks(depot, sha, conclusion)}:${evenement}:${n(c.id) ?? ""}`, brut: `${evenement}.completed` }), depot, branche, sha, numeroPr: n(prs[0]?.number), statut: conclusion, auteur, url: s(c.html_url), survenuLe: s(c.completed_at) ?? s(c.updated_at) }];
  }
  if (evenement === "workflow_run") {
    const w = o(corps.workflow_run);
    if (action !== "completed") return [];
    const prs = Array.isArray(w.pull_requests) ? w.pull_requests.map(o) : [];
    return [{ ...vide({ type: "DEV_WORKFLOW", fournisseur: "github", cle: `workflow:${depot}:${n(w.id)}:${n(w.run_attempt) ?? 1}:${s(w.conclusion) ?? ""}`, brut: "workflow_run.completed" }), depot, branche: s(w.head_branch), sha: s(w.head_sha), numeroPr: n(prs[0]?.number), statut: s(w.conclusion), auteur, url: s(w.html_url), survenuLe: s(w.updated_at) }];
  }
  if (evenement === "issue_comment") {
    const issue = o(corps.issue);
    const com = o(corps.comment);
    if (action !== "created" || !issue.pull_request || !n(com.id)) return [];
    return [{ ...vide({ type: "DEV_COMMENTAIRE", fournisseur: "github", cle: `commentaire:${depot}:${n(com.id)}`, brut: "issue_comment.created" }), depot, numeroPr: n(issue.number), statut: s(o(com.user).type) === "Bot" ? "bot" : "humain", auteur: s(o(com.user).login), url: s(com.html_url), survenuLe: s(com.created_at) }];
  }
  return [];
}

const TYPES_RENDER_DEPLOIEMENT = new Set(["deploy_started", "deploy_ended", "build_ended", "pre_deploy_ended"]);
const TYPES_RENDER_SERVICE = new Set(["server_failed", "server_available", "server_restarted", "service_suspended", "service_resumed"]);

/** Le détail qu'un webhook Render n'a pas (le `deployId`), lu par `GET /events/{id}` quand c'est possible. */
export interface DetailEvenementRender { deployId: string | null }

/** UN corps Render (charge « mince ») → zéro ou un fait. */
export function faitsRender(corps: Brut, detail: DetailEvenementRender | null = null): FaitDev[] {
  const type = s(corps.type);
  const data = o(corps.data);
  const evt = s(data.id);
  if (!type || !evt) return [];
  const serviceId = s(data.serviceId);
  if (TYPES_RENDER_DEPLOIEMENT.has(type)) {
    const statut = type === "deploy_started" ? "started" : s(data.status) ?? "inconnu";
    // Un build ou un pré-déploiement RÉUSSI n'est pas la fin du déploiement : seul son échec en est une.
    if ((type === "build_ended" || type === "pre_deploy_ended") && statut === "succeeded") return [];
    const deployId = detail?.deployId ?? null;
    const cle = deployId && statut !== "started" ? cleDeploiement(deployId, statut) : `render:evt:${evt}`;
    return [{ ...vide({ type: "RENDER_DEPLOIEMENT", fournisseur: "render", cle, brut: type }), serviceId, deployId, statut, survenuLe: s(corps.timestamp), auteur: s(data.serviceName) }];
  }
  if (TYPES_RENDER_SERVICE.has(type)) {
    return [{ ...vide({ type: "RENDER_SERVICE", fournisseur: "render", cle: `render:evt:${evt}`, brut: type }), serviceId, statut: type, survenuLe: s(corps.timestamp), auteur: s(data.serviceName) }];
  }
  return [];
}
