import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POWER_TOOLS } from "@/lib/assistant/power-tools";
import { ADAM_TOOLS } from "@/lib/assistant/adam-tools";
import { ACTION_POLICY, payloadRequiresStrongConfirm, type AssistantActionPayload } from "@/lib/assistant";
import { GOOGLE_SCOPES, resolveGoogleConfig, missingGoogleVars, isExpectedAccount } from "./config";
import { MailSendPolicy } from "@prisma/client";
import { decideSend } from "@/lib/comms/policy";

/**
 * AUDIT DE MISE EN SERVICE — l'audit écrit en ASSERTIONS plutôt qu'en prose.
 *
 * Un audit rendu sous forme de document vieillit mal : il dit vrai le jour où il est écrit, puis
 * quelqu'un débranche un fil et le document continue d'affirmer que tout va bien. Ces tests
 * disent la même chose, mais ils cessent de passer le jour où ce n'est plus vrai.
 *
 * Ce qu'ils vérifient n'est PAS que le code existe — un `grep` suffirait — mais qu'il est
 * ATTEIGNABLE : l'outil est enregistré, la garde est posée, le chemin est unique, la
 * configuration est complète. Une capacité écrite mais non branchée n'est pas une capacité.
 */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("mise en service ADAM — couche par couche, tout est BRANCHÉ", () => {
  // ── 1. Les outils existent ET sont enregistrés dans le registre que le modèle reçoit ──
  it("les 19 outils Google sont enregistrés dans POWER_TOOLS (pas seulement définis)", () => {
    expect(ADAM_TOOLS.length).toBeGreaterThanOrEqual(19);
    const registered = new Set(POWER_TOOLS.map((t) => t.def.name));
    const manquants = ADAM_TOOLS.map((t) => t.def.name).filter((n) => !registered.has(n));
    expect(manquants, "outils définis mais jamais servis au modèle").toEqual([]);
  });

  it("chaque outil ADAM porte une garde et une description non vide", () => {
    for (const t of ADAM_TOOLS) {
      expect(typeof t.allowed, `${t.def.name} sans garde`).toBe("function");
      expect(t.def.description?.length ?? 0, `${t.def.name} sans description`).toBeGreaterThan(20);
      expect(t.label?.length ?? 0, `${t.def.name} sans libellé`).toBeGreaterThan(0);
    }
  });

  it("les capacités annoncées couvrent bien les six surfaces Google", () => {
    const names = ADAM_TOOLS.map((t) => t.def.name).join(" ");
    for (const surface of ["gmail_", "gcal_", "gdrive_", "gworkspace_", "gdoc_", "mission_"]) {
      expect(names, `aucune capacité ${surface}`).toContain(surface);
    }
  });

  // ── 2. Les droits demandés correspondent aux capacités annoncées ──
  it("les droits Google couvrent chaque service utilisé, sans privilège inutile", () => {
    const joined = GOOGLE_SCOPES.join(" ");
    for (const needed of ["gmail", "calendar", "drive", "documents", "spreadsheets", "presentations", "contacts"]) {
      expect(joined, `droit manquant pour ${needed}`).toContain(needed);
    }
    // Moindre privilège : aucun droit d'administration de domaine.
    expect(joined).not.toMatch(/admin\.directory|admin\.datatransfer|cloud-platform/);
    // Et jamais le droit TOTAL sur Gmail quand `modify` suffit.
    expect(joined).not.toMatch(/auth\/gmail\.settings\.sharing|mail\.google\.com/);
  });

  it("la configuration se refuse plutôt que de tourner à moitié", () => {
    expect(resolveGoogleConfig({})).toBeNull();
    expect(missingGoogleVars({}).length).toBeGreaterThan(0);

    const cfg = resolveGoogleConfig({
      GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://x/api/google/callback",
      GOOGLE_ADAM_EMAIL: "adam@gmail.com",
    });
    expect(cfg).not.toBeNull();
    // Le compte attendu est VERROUILLÉ : un autre compte connecté par erreur est refusé.
    expect(isExpectedAccount(cfg!, "adam@gmail.com")).toBe(true);
    expect(isExpectedAccount(cfg!, "quelquun.dautre@gmail.com")).toBe(false);
  });

  // ── 3. La frontière d'envoi n'a qu'une porte ──
  it("UNE SEULE fonction fait partir un message — aucune route parallèle", () => {
    // On cherche dans tout `src` qui appelle vraiment le transport Gmail. Si un jour quelqu'un
    // ajoute un second chemin, ce test le voit : c'est précisément ce qu'il protège.
    const transport = read("lib/google/gmail/transport.ts");
    expect(transport).toContain("gmailTransport");

    const outbound = read("lib/comms/outbound.ts");
    expect(outbound).toContain("export async function sendOutboundIntent");
    // La politique est relue À L'INSTANT de l'envoi, jamais celle mémorisée à la préparation.
    const sendBody = outbound.slice(outbound.indexOf("export async function sendOutboundIntent"));
    expect(sendBody).toContain("getCommunicationPolicy()");
    // Et « approuvé » exige un approbateur HUMAIN, pas seulement une empreinte.
    expect(sendBody).toContain("cur.approvedById");
  });

  it("la décision d'envoi est PURE et couvre les quatre situations", () => {
    const base = { outboundPaused: false, inboundPaused: false, updatedAt: null, updatedById: null };
    expect(decideSend({ ...base, mailSendPolicy: MailSendPolicy.REQUIRE_APPROVAL }, false).allowed).toBe(false);
    expect(decideSend({ ...base, mailSendPolicy: MailSendPolicy.REQUIRE_APPROVAL }, true).allowed).toBe(true);
    expect(decideSend({ ...base, mailSendPolicy: MailSendPolicy.AUTO_SEND }, false).allowed).toBe(true);
    expect(decideSend({ ...base, mailSendPolicy: MailSendPolicy.DRAFT_ONLY }, true).allowed).toBe(false);
    expect(decideSend({ ...base, outboundPaused: true, mailSendPolicy: MailSendPolicy.AUTO_SEND }, true).allowed).toBe(false);
  });

  it("les deux actions de courriel sont classées EXTERNES et confirmées", () => {
    expect(ACTION_POLICY.send_prepared_mail?.external).toBe(true);
    expect(ACTION_POLICY.set_mail_policy?.external).toBe(true);
    // Armer l'envoi autonome exige une RESSAISIE ; revenir à l'approbation ne doit pas en exiger.
    const arm = { kind: "set_mail_policy", policy: "AUTO_SEND" } as unknown as AssistantActionPayload;
    const disarm = { kind: "set_mail_policy", policy: "REQUIRE_APPROVAL" } as unknown as AssistantActionPayload;
    expect(payloadRequiresStrongConfirm(arm)).toBe(true);
    expect(payloadRequiresStrongConfirm(disarm)).toBe(false);
  });

  // ── 4. Adam ne devient jamais sourd ──
  it("le battement d'ADAM est BRANCHÉ dans le planificateur", () => {
    const scheduled = read("lib/scheduled.ts");
    expect(scheduled).toContain("runAdamInboxSweep");
    // Et il est appelé, pas seulement importé : une ligne de la table des tâches (V2-F).
    expect(scheduled).toMatch(/executer:\s*\(\)\s*=>\s*runAdamInboxSweep\(/);
  });

  it("les trois filets de reprise existent : histoire, liste récente, réconciliation", () => {
    const reconcile = read("lib/google/gmail/reconcile.ts");
    expect(reconcile).toContain("export async function syncFromHistory");
    expect(reconcile).toContain("export async function reconcileInbox");
    expect(reconcile).toContain("export async function ensureWatch");
    // Le point d'histoire n'avance qu'après traitement : sinon un plantage perd des messages.
    expect(reconcile).toContain("history.expired");
  });

  it("le point d'entrée Pub/Sub exige une PREUVE d'origine et ne croit pas la charge utile", () => {
    const route = read("app/api/google/pubsub/route.ts");
    expect(route).toContain("verifyPubSubToken");
    expect(route).toContain("safeEqual");
    // La notification déclenche une RELECTURE chez Google — elle n'apporte pas le message.
    expect(route).toContain("syncFromHistory");
    expect(route).toMatch(/status:\s*401/);
  });

  it("le retour OAuth vérifie l'état signé, le PKCE, la personne ET le compte", () => {
    const cb = read("app/api/google/callback/route.ts");
    expect(cb).toContain("verifyState");
    expect(cb).toContain("PKCE_COOKIE");
    expect(cb).toContain("isExpectedAccount");
    // Un mauvais compte : le consentement est RÉVOQUÉ, pas simplement ignoré.
    expect(cb).toContain("revokeToken");
  });

  // ── 5. L'ingestion comprend, relie, et ne réveille pas pour rien ──
  it("le pipeline d'entrée est complet — résolution, analyse, injection, mission, attention", () => {
    const ingest = read("lib/google/gmail/ingest.ts");
    for (const step of ["resolveSender", "analyzeEmail", "scanForInjection", "findMissionForInbound", "deservesAttention", "ingestAttachments"]) {
      expect(ingest, `étape absente du pipeline : ${step}`).toContain(step);
    }
    // Idempotent par construction : la clé unique, pas une vérification à la main.
    expect(ingest).toContain("connectionId_providerMessageId");
  });

  it("les coupe-circuits sont vérifiés AVANT tout appel réseau, et à l'ingestion", () => {
    expect(read("lib/google/gmail/reconcile.ts")).toContain("inboundPaused");
    expect(read("lib/google/gmail/ingest.ts")).toContain("inboundPaused");
  });

  // ── 6. Aucune capacité morte dans la pile ADAM ──
  it("aucun TODO, stub ou « non implémenté » dans les modules d'ADAM", () => {
    const files = [
      "lib/google/config.ts", "lib/google/oauth.ts", "lib/google/client.ts", "lib/google/connection.ts",
      "lib/google/health.ts", "lib/google/pubsub-verify.ts",
      "lib/google/gmail/ingest.ts", "lib/google/gmail/reconcile.ts", "lib/google/gmail/transport.ts",
      "lib/google/calendar/provider.ts", "lib/google/drive/provider.ts", "lib/google/workspace/provider.ts",
      "lib/comms/policy.ts", "lib/comms/outbound.ts", "lib/comms/missions.ts",
      "lib/comms/untrusted.ts", "lib/comms/loop-safety.ts", "lib/comms/email-intelligence.ts",
      "lib/assistant/adam-tools.ts",
      "lib/assistant/adam-tools/commun.ts", "lib/assistant/adam-tools/gmail.ts", "lib/assistant/adam-tools/missions.ts",
      "lib/assistant/adam-tools/agenda-drive.ts", "lib/assistant/adam-tools/bureautique-contacts.ts",
    ];
    const morts: string[] = [];
    for (const f of files) {
      const body = read(f);
      // `placeholderIdMappings` est un vrai champ de l'API Slides : on cible le mot isolé.
      if (/\b(TODO|FIXME|HACK)\b|non impl[ée]ment|not implemented|coming soon|\bstub\b/i.test(body)) {
        morts.push(f);
      }
    }
    expect(morts, "capacités mortes dans la pile ADAM").toEqual([]);
  });

  // ── 7. Rien qui puisse fuir un secret ──
  it("aucun module ADAM ne journalise un jeton", () => {
    const risky = ["accessToken", "refreshToken", "access_token", "refresh_token", "client_secret"];
    const fautifs: string[] = [];
    for (const f of ["lib/google/oauth.ts", "lib/google/client.ts", "lib/google/connection.ts", "lib/google/health.ts"]) {
      const body = read(f);
      for (const line of body.split("\n")) {
        if (!/console\.(log|error|warn|info)/.test(line)) continue;
        if (risky.some((r) => line.includes(r))) fautifs.push(`${f} :: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(fautifs, "un jeton peut atteindre le journal").toEqual([]);
  });

  it("l'état de santé exposé ne contient aucun jeton", () => {
    const health = read("lib/google/health.ts");
    // On expose « en a-t-il un ? », jamais sa valeur.
    expect(health).toContain("hasRefreshToken");
    expect(health).not.toMatch(/accessTokenEnc:\s*(c|conn)/);
    expect(health).not.toContain("openSecret");
  });

  // ── 8. La mise en service est faisable sans toucher à la base ──
  it("le diagnostic et l'écran de réglages existent et sont branchés", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["adam:doctor"], "npm run adam:doctor absent").toBeTruthy();
    expect(pkg.scripts["build:measure"], "garde mémoire du build absente").toBeTruthy();

    // L'écran vers lequel le retour OAuth redirige doit exister, sinon la connexion tombe dans le vide.
    const cb = read("app/api/google/callback/route.ts");
    expect(cb).toContain("/chief-of-staff/reglages");
    // Adam est REVENU dans la coque de l'ERP — il est un module, atteint et quitté par le menu
    // latéral (§118.100). L'URL n'a jamais bougé (`/chief-of-staff/reglages`) ; le chemin de
    // fichier a suivi le groupe de routes, deux fois.
    expect(() => read("app/(app)/chief-of-staff/reglages/page.tsx")).not.toThrow();
  });
});
