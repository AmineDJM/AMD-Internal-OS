import "@/lib/async-local-storage-global";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { oublierTentativesSortantes, tentativesSortantes } from "@/lib/sortie/garde";
import { sendMail } from "@/lib/mail";
import { sendSmartEmail } from "@/lib/mail-smart";
import { MicrosoftGraphMailProvider } from "@/lib/mail/graph/provider";
import { sendPushToUser } from "@/lib/push";
import { envoyerAuSite } from "@/lib/site-web/transport";
import { completeMultipartUpload, createMultipartUpload, deleteObject, putObject, putObjectStream } from "@/lib/storage/object-storage";
import { simulerGeste } from "./simulation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ZÉRO EFFET EXTERNE EN SIMULATION — un test PAR PORT (J7, décision 0029).
 *
 * Chaque port est APPELÉ pour de vrai, sous une simulation. La preuve qu'il n'est rien sorti est double :
 *   • la garde de sortie (`sortie/garde.ts`), armée sous vitest, LÈVE ou NOTE toute tentative qui l'atteint — sa liste
 *     reste vide : le port a rendu la main AVANT la garde, donc avant tout transport ;
 *   • le `fetch` de la plateforme, espionné, n'est jamais appelé.
 * Et l'effet est NOTÉ dans la capture, « neutralisé » : la carte peut dire « 1 courriel à … — non envoyé ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const moi = { id: "port-test", name: "Port", email: "port@t.dz", role: "SUPER_ADMIN", access: {}, mustChangePassword: false } as unknown as CurrentUser;
const reseau = vi.fn(async () => new Response("{}", { status: 200 }));

const sousSimulation = async (geste: () => Promise<unknown>) => {
  const issue = await simulerGeste(moi, { origine: "test" }, geste);
  return issue;
};

suite("aucun effet externe ne sort d'une simulation — port par port", () => {
  beforeAll(() => {
    // Le port réseau se pose sur le `fetch` présent : on y met un espion AVANT qu'il ne s'installe.
    delete (globalThis as { __amdPortReseau?: true }).__amdPortReseau;
    globalThis.fetch = reseau as unknown as typeof fetch;
  });
  afterEach(() => {
    oublierTentativesSortantes();
    reseau.mockClear();
  });

  const preuve = (issue: Awaited<ReturnType<typeof sousSimulation>>, acte: string) => {
    expect(issue.ok, issue.erreur).toBe(true);
    expect(tentativesSortantes(), "la garde a vu passer une tentative : le port n'a pas rendu la main avant").toEqual([]);
    expect(reseau).not.toHaveBeenCalled();
    const e = issue.capture.effets.filter((x) => x.acte === acte);
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((x) => x.neutralise)).toBe(true);
  };

  it("courriel SMTP (`sendMail`) : noté, jamais composé ni envoyé", async () => {
    const compte = { id: "c", email: "moi@adventum.dz", displayName: "Moi" } as Parameters<typeof sendMail>[0];
    preuve(await sousSimulation(() => sendMail(compte, { to: "karim@adventum.dz", subject: "Relance" })), "COURRIEL");
  });

  it("courriel Microsoft Graph (`send`) : noté, pas même le brouillon", async () => {
    const p = new MicrosoftGraphMailProvider("jeton", "moi@adventum.dz");
    preuve(await sousSimulation(() => p.send({ to: [{ address: "karim@adventum.dz" }], subject: "Relance" } as Parameters<typeof p.send>[0])), "COURRIEL");
  });

  it("courriel par API (`sendSmartEmail`) : noté, succès simulé rendu", async () => {
    let r: unknown;
    preuve(await sousSimulation(async () => { r = await sendSmartEmail({ to: ["karim@adventum.dz"], subject: "Relance", text: "x" }); }), "COURRIEL");
    expect(r).toEqual({ ok: true, providerId: "simulation" });
  });

  it("notification poussée (`sendPushToUser`) : notée, aucun appareil contacté", async () => {
    preuve(await sousSimulation(() => sendPushToUser("karim", { title: "Nouvelle tâche" })), "NOTIFICATION_PUSH");
  });

  it("site Adventum (`envoyerAuSite`) : noté, réponse « acceptée » sans requête", async () => {
    let r: { statut: number | null } | undefined;
    preuve(await sousSimulation(async () => { r = await envoyerAuSite({ methode: "POST", chemin: "/api/articles", corps: "{}" } as Parameters<typeof envoyerAuSite>[0]); }), "ECRITURE_EXTERNE");
    expect(r?.statut).toBe(202);
  });

  it("stockage objet (dépôt, dépôt en parties, suppression) : noté, le bucket n'est pas touché", async () => {
    preuve(await sousSimulation(async () => {
      await putObject("blobs/aa", Buffer.from("x"));
      await putObjectStream("blobs/bb", (async function* () { yield Buffer.from("y"); })());
      const id = await createMultipartUpload("blobs/cc", "application/pdf");
      await completeMultipartUpload("blobs/cc", id, []);
      await deleteObject("blobs/dd");
    }), "STOCKAGE");
  });

  it("tout autre appel réseau qui écrit (webhook, fournisseur) : neutralisé, réponse 202 ; une lecture passe", async () => {
    let statut = 0;
    const issue = await sousSimulation(async () => {
      statut = (await fetch("https://hooks.exemple.dz/commande", { method: "POST", body: "{}" })).status;
      await fetch("https://fournisseur.exemple.dz/catalogue");
    });
    expect(issue.ok).toBe(true);
    expect(statut).toBe(202);
    expect(reseau).toHaveBeenCalledTimes(1);
    expect(issue.capture.effets).toEqual([expect.objectContaining({ acte: "RESEAU", cible: "POST hooks.exemple.dz/commande", neutralise: true })]);
  });

  it("hors simulation, les mêmes ports laissent la garde faire son travail (le port ne masque rien)", async () => {
    const compte = { id: "c", email: "moi@adventum.dz", displayName: "Moi" } as Parameters<typeof sendMail>[0];
    await expect(sendMail(compte, { to: "karim@adventum.dz", subject: "Relance" })).rejects.toThrow(/SORTIE INTERDITE/);
  });
});

describe("le port de simulation est posé partout où la garde de sortie l'est (règle d'architecture)", () => {
  it("tout module qui appelle la garde de sortie appelle AUSSI le port de simulation, et AVANT elle", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const fichiers = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? fichiers(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
    });
    const GARDE = /\b(exigerSortieAutorisee|sortieAutorisee)\s*\(/;
    const fautifs: string[] = [];
    let vus = 0;
    for (const f of fichiers(join(process.cwd(), "src"))) {
      if (f.endsWith(join("sortie", "garde.ts"))) continue;
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const g = src.search(GARDE);
      if (g < 0) continue;
      vus += 1;
      const p = src.search(/\bnoterEffetExterne\s*\(/);
      if (p < 0 || p > g) fautifs.push(relative(process.cwd(), f));
    }
    expect(vus).toBeGreaterThanOrEqual(5);
    expect(fautifs, `ces modules sortent sans le port de simulation (J7) :\n  ${fautifs.join("\n  ")}`).toEqual([]);
  });
});
