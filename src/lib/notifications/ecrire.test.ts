import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { notifyRoles } from "@/lib/notify";
import { rejouerNotifications } from "./ecrire";

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__ecrnotif__";

suite("un destinataire disparu ne fait pas taire l'envoi", () => {
  let vivantA = "", vivantB = "", efface = "";

  beforeAll(async () => {
    const mk = (s: string, role: "SALES_USER" | "MEDICAL_DELEGATE") =>
      prisma.user.create({
        data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role } as never,
      });
    const [a, b, c] = await Promise.all([mk("a", "SALES_USER"), mk("b", "SALES_USER"), mk("parti", "SALES_USER")]);
    vivantA = a.id; vivantB = b.id; efface = c.id;
    // LE COMPTE DISPARAÎT — c'est exactement l'état que produit la course entre la lecture des
    // destinataires et l'écriture des lignes. Aucun faux-semblant : la ligne n'existe plus.
    await prisma.user.delete({ where: { id: efface } });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const ligne = (userId: string, titre: string) =>
    ({ userId, type: "GENERIC" as const, title: `${TAG}${titre}` });

  it("LE REJEU ÉCRIT LES SURVIVANTS, et le disparu est le seul perdu", async () => {
    // Le cas mesuré en production : le lot ENTIER était rejeté et personne n'était prévenu.
    const ecrites = await rejouerNotifications(
      [ligne(vivantA, "course"), ligne(efface, "course"), ligne(vivantB, "course")],
      new Error("lot refusé (simulation du refus de clé étrangère)"),
    );

    expect(ecrites, "deux destinataires existent toujours").toBe(2);
    const compte = (userId: string) =>
      prisma.notification.count({ where: { userId, title: `${TAG}course` } });
    expect(await compte(vivantA)).toBe(1);
    expect(await compte(vivantB)).toBe(1);
    expect(await compte(efface), "le compte n'existe plus : rien ne lui est écrit").toBe(0);
  });

  it("une liste vide n'écrit rien et ne se plaint pas", async () => {
    expect(await rejouerNotifications([], new Error("rien"))).toBe(0);
  });

  it("PAR LE VRAI POINT D'ENTRÉE : `notifyRoles` prévient les vivants malgré un compte effacé", async () => {
    // Le défaut ne se voit que par l'appelant : c'est lui qui LIT les destinataires puis écrit.
    // On recrée un compte du rôle visé, on en efface un autre, et l'on regarde qui reçoit.
    const survivant = await prisma.user.create({
      data: { name: `${TAG}md-vit`, email: `${TAG}md-vit@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } as never,
    });
    const doomed = await prisma.user.create({
      data: { name: `${TAG}md-part`, email: `${TAG}md-part@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } as never,
    });
    // La lecture des destinataires a lieu DANS `notifyRoles` ; pour reproduire la course sans
    // instrumenter le produit, le compte est effacé juste avant l'appel — la requête de lecture
    // ne le verra pas, mais le cas « le lot part avec un identifiant mort » est déjà couvert
    // ci-dessus. Ce que ce cas prouve, c'est que le chemin complet écrit bien ses lignes.
    await prisma.user.delete({ where: { id: doomed.id } });

    await notifyRoles(["MEDICAL_DELEGATE"], { type: "GENERIC", title: `${TAG}roles` });
    expect(
      await prisma.notification.count({ where: { userId: survivant.id, title: `${TAG}roles` } }),
      "le survivant du rôle visé est prévenu",
    ).toBe(1);
  });
});

/**
 * LE CLIQUET — il ne vérifie pas le CORPS du rejeu, il cherche ses POINTS D'APPEL (§118.49).
 *
 * Le remède existait depuis longtemps dans `directives/recipients.ts` et cinq autres écrivains
 * refaisaient le défaut à côté : c'est cette règle-là, et elle seule, qui empêche le septième
 * d'arriver demain par la porte qu'on n'a pas regardée (§118.58, §118.71).
 *
 * Il s'arme sur un fait de POSITION : le `catch` qui rejoue suit immédiatement le `createMany`.
 * Exiger seulement que le fichier « contienne » l'appel laisserait passer un second écrivain
 * ajouté dans un fichier déjà conforme.
 */
describe("tout lot de notifications écrit en production sait se rejouer", () => {
  const RACINE = join(process.cwd(), "src");
  const fichiers: string[] = [];
  const parcourir = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) parcourir(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) fichiers.push(p);
    }
  };
  parcourir(RACINE);

  it("le parc est réellement lu (sans quoi le cliquet serait vert en ne lisant rien)", () => {
    expect(fichiers.length).toBeGreaterThan(900);
  });

  it("chaque `notification.createMany` est suivi d'un `catch` qui rejoue ligne à ligne", () => {
    const nus: string[] = [];
    let trouves = 0;
    for (const p of fichiers) {
      const src = readFileSync(p, "utf8");
      const re = /notification\s*\.\s*createMany/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        trouves += 1;
        // La fenêtre couvre le `catch` qui suit l'appel, pas le fichier entier.
        if (!/rejouerNotifications\s*\(/.test(src.slice(m.index, m.index + 400))) {
          nus.push(`${p.replace(process.cwd() + "/", "")}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    // Un plancher : si la recherche cessait de trouver les écrivains, elle serait verte pour rien.
    expect(trouves, "les écrivains de lots doivent être trouvés").toBeGreaterThanOrEqual(6);
    expect(nus, "ces lots perdraient tout pour un seul destinataire disparu").toEqual([]);
  });
});
