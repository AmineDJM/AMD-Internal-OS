import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

// `redirect` lève dans Next.js ; ici, elle lève l'adresse visée pour qu'on la lise.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));

import AncienneFicheCourrier from "@/app/(app)/courriers/[id]/page";
import { lienCourrier, lienRegistreCourriers } from "@/lib/chemins/courriers";
import { entityHref } from "@/lib/entity-href";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";

const lire = (f: string) => fs.readFileSync(f, "utf8");

/**
 * UN COURRIER S'OUVRE DANS LE PANNEAU DU REGISTRE — plus de page par courrier (Super Admin, 24/11).
 *
 * Ce qui doit tenir : les anciens liens (`/courriers/<id>`) mènent au panneau ; tous les liens
 * produits aujourd'hui y mènent directement ; et le panneau n'ouvre que ce que le registre montre —
 * la porte des droits est vérifiée sur la base dans `courrier-visible-mais-404.test.ts`.
 */
describe("/courriers/<id> → le panneau du registre", () => {
  it("l'ancienne adresse redirige vers /courriers?courrier=<id>", async () => {
    await expect(AncienneFicheCourrier({ params: Promise.resolve({ id: "c42" }) })).rejects.toThrow("REDIRECT:/courriers?courrier=c42");
  });

  it("l'identifiant est encodé : il ne peut pas injecter un autre paramètre", () => {
    expect(lienCourrier("a&dossier=x")).toBe("/courriers?courrier=a%26dossier%3Dx");
  });

  it("le dossier ouvert reste ouvert derrière le panneau", () => {
    expect(lienCourrier("c1", "d9")).toBe("/courriers?dossier=d9&courrier=c1");
    expect(lienRegistreCourriers("d9")).toBe("/courriers?dossier=d9");
    expect(lienRegistreCourriers(null)).toBe("/courriers");
  });

  it("les liens produits aujourd'hui ouvrent le panneau, sans escale", () => {
    expect(entityHref("MAIL_ENTRY", "c1")).toBe(lienCourrier("c1"));
  });

  it("une notification déjà écrite vers l'ancienne page ouvre le panneau", () => {
    expect(reécriteLienNotification("/courriers/c1")).toBe("/courriers?courrier=c1");
    expect(reécriteLienNotification("/courriers?courrier=c1")).toBe("/courriers?courrier=c1");
  });
});

describe("le panneau garde la porte de l'ancienne page", () => {
  const page = lire("src/app/(app)/courriers/page.tsx");
  const fiche = lire("src/lib/mail-register/fiche.ts");
  const escale = lire("src/app/(app)/courriers/[id]/page.tsx");

  it("le registre n'ouvre le panneau que sur ce que `chargerFicheCourrier` a retrouvé", () => {
    expect(page).toMatch(/requireModule\("MAIL_REGISTER"\)/);
    expect(page).toMatch(/chargerFicheCourrier\(user, courrierId\)/);
    expect(page).toMatch(/\{fiche && <FicheCourrierPanneau/);
  });

  it("le chargement passe par la clause de visibilité de la liste, jamais par l'identifiant seul", () => {
    expect(fiche).toMatch(/where: \{ AND: \[await clauseCourriersVisibles\(user\.id\), \{ id \}\] \}/);
    expect(fiche).not.toMatch(/findUnique\(/);
  });

  it("la page d'escale ne lit aucune donnée : elle redirige, le registre décide", () => {
    expect(escale).not.toMatch(/prisma/);
    expect(escale).toMatch(/redirect\(lienCourrier\(id\)\)/);
  });
});
