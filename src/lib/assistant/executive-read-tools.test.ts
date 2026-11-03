import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { executePowerTool } from "./power-tools";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AGENDA SUR UNE PÉRIODE — par le VRAI point d'entrée (`executePowerTool`, qui revérifie le
 * droit), pas en appelant le corps de l'outil (§118.49).
 *
 * ── LE DÉFAUT QUE CE FICHIER GARDE ───────────────────────────────────────────────────────
 *
 * Campagne live, `defi-autonomie-composition` : « Combien d'heures de réunion ai-je eues ces 30
 * derniers jours, et avec qui le plus souvent ? » → « INCONNU — le calendrier Google d'ADAM
 * n'est pas connecté ». L'ERP a son propre agenda, et `getCalendarEvents(user, from, to)` — la
 * lecture par FENÊTRE — vivait dans le même fichier que l'appel qui ne s'en servait que pour UN
 * jour. Ce que l'outil ne savait pas exprimer, le modèle l'a rendu en impossibilité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = "__caltest__";
const JOUR = 86_400_000;
const ids: string[] = [];
let acteur: CurrentUser | null = null;
let moi = "";
let collegue = "";

/**
 * LE JOUR SE CALCULE DANS LE FUSEAU DE L'OUTIL, PAS EN UTC. `read_calendar` borne un jour à
 * l'heure d'Alger (`algiersInputToUtc`). Écrit `toISOString().slice(0, 10)`, ce juge donnait le
 * jour UTC : entre 23 h et minuit UTC, Alger est déjà au lendemain, et « le comité d'il y a dix
 * jours » tombait hors du jour demandé — rouge une heure par jour, sur une règle juste (mesuré
 * à 23 h 49 UTC, en isolation comme sous la suite complète ; §118.131, même famille).
 */
const ymd = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

beforeAll(async () => {
  /**
   * L'ACTEUR N'A PAS LA VUE GLOBALE, ET C'EST LA MOITIÉ DU BANC.
   *
   * La première version prenait `DIRECTION`. Or `DIRECTION` est dans `GLOBAL_VIEW_ROLES`, donc
   * `scopeWhere` de `lib/calendar.ts` rend `{}` : l'acteur voyait l'agenda de TOUTE la base.
   * Mesuré en suite complète : un événement créé au même moment par un AUTRE fichier de test —
   * vitest exécute les fichiers en parallèle — entrait dans le total, et les deux assertions
   * tombaient (« 2 au lieu de 1 », « 5 au lieu de 4 »). En isolation, 3 fois sur 3 au vert : le
   * pire genre d'échec, parce qu'il accuse le code au lieu du voisinage (§118.91, §118.83).
   *
   * Un `COORDINATOR` passe par la branche CLOISONNÉE — organisateur OU invité — donc le banc ne
   * voit que ce qu'il a créé, quoi que fassent les autres fichiers. C'est aussi le cas le plus
   * fréquent en production : presque personne n'a la vue globale.
   */
  const a = await prisma.user.create({ data: { name: `${PREFIXE} Organisateur`, email: `${PREFIXE}org@test.invalid`, passwordHash: "x", role: "COORDINATOR", isActive: true } });
  const b = await prisma.user.create({ data: { name: `${PREFIXE} Collègue`, email: `${PREFIXE}col@test.invalid`, passwordHash: "x", role: "COORDINATOR", isActive: true } });
  moi = a.id; collegue = b.id;
  // L'ACCÈS VIENT DU VRAI RÉSOLVEUR : un `access` fabriqué à la main ferait passer la porte
  // du module sans rien prouver, et c'est cette porte-là qui décide (§118.49).
  acteur = { id: a.id, name: a.name, email: a.email, role: a.role, access: await getAccess(a.id, a.role) } as unknown as CurrentUser;

  const t = Date.now();
  // DEUX réunions PASSÉES avec une fin connue (90 + 30 = 120 min), et UNE sans heure de fin.
  const plan: { titre: string; debut: Date; fin: Date | null; invite: boolean }[] = [
    { titre: `${PREFIXE} comité passé`, debut: new Date(t - 10 * JOUR), fin: new Date(t - 10 * JOUR + 90 * 60_000), invite: true },
    { titre: `${PREFIXE} point passé`, debut: new Date(t - 3 * JOUR), fin: new Date(t - 3 * JOUR + 30 * 60_000), invite: true },
    { titre: `${PREFIXE} appel sans fin`, debut: new Date(t - 5 * JOUR), fin: null, invite: false },
    // Hors fenêtre : 200 jours en arrière — il ne doit PAS entrer dans le total.
    { titre: `${PREFIXE} très ancien`, debut: new Date(t - 200 * JOUR), fin: new Date(t - 200 * JOUR + 600 * 60_000), invite: true },
  ];
  for (const p of plan) {
    const e = await prisma.calendarEvent.create({
      data: {
        title: p.titre, kind: "MEETING", startAt: p.debut, endAt: p.fin, allDay: false,
        organizerId: moi, createdById: moi,
        ...(p.invite ? { invitees: { create: [{ userId: collegue, status: "ACCEPTED" }] } } : {}),
      },
      select: { id: true },
    });
    ids.push(e.id);
  }
});

afterAll(async () => {
  await prisma.calendarEvent.deleteMany({ where: { id: { in: ids } } });
  await retirerComptesEtSemis({ where: { id: { in: [moi, collegue] } } });
});

describe("read_calendar sur une PÉRIODE passée", () => {
  it("lit les 30 derniers jours, totalise les heures et classe les personnes rencontrées", async () => {
    const t = Date.now();
    const brut = await executePowerTool("read_calendar", { du: ymd(new Date(t - 30 * JOUR)), au: ymd(new Date(t)), limit: 50 }, acteur!);
    expect(brut, "l'outil n'a rien rendu").toBeTruthy();
    const r = JSON.parse(brut!) as {
      evenements: number; total_heures: number; evenements_sans_heure_de_fin: number;
      note_total?: string; rencontres_les_plus_frequentes: { personne: string; evenements: number }[];
    };
    // 90 + 30 minutes = 2 h. L'appel sans heure de fin est COMPTÉ comme événement et EXCLU du
    // total : lui prêter soixante minutes fabriquerait un chiffre qui a l'air juste (§118.16).
    expect(r.total_heures).toBe(2);
    expect(r.evenements_sans_heure_de_fin).toBe(1);
    expect(r.note_total, "ce qui n'est pas totalisé doit être DIT").toMatch(/sans heure de fin/i);
    expect(r.evenements).toBe(3);
    const col = r.rencontres_les_plus_frequentes.find((x) => x.personne.includes("Collègue"));
    expect(col?.evenements, "le collègue est invité à deux des trois réunions").toBe(2);
  });

  it("la fenêtre BORNE : l'événement d'il y a 200 jours n'entre pas dans le total", async () => {
    const t = Date.now();
    const large = JSON.parse((await executePowerTool("read_calendar", { du: ymd(new Date(t - 365 * JOUR)), au: ymd(new Date(t)), limit: 50 }, acteur!))!) as { evenements: number; total_heures: number };
    expect(large.evenements).toBe(4);
    expect(large.total_heures).toBe(12); // 2 h + 10 h
  });

  /**
   * L'ABSENCE SE DIT COMME UNE ABSENCE. C'est la phrase exacte que le défaut mesuré avait
   * remplacée par « le calendrier Google n'est pas connecté » : NON TROUVÉ annoncé comme SOURCE
   * INDISPONIBLE envoie le dirigeant brancher un service tiers pour rien (§118.63).
   */
  it("une période vide rend une ABSENCE CONSTATÉE, jamais une source manquante", async () => {
    const r = await executePowerTool("read_calendar", { du: "2019-01-01", au: "2019-01-31" }, acteur!);
    expect(r).toMatch(/Aucun événement dans l'agenda de l'ERP/i);
    expect(r).toMatch(/ABSENCE constatée/i);
    expect(r ?? "").not.toMatch(/google|non connect/i);
  });

  it("une borne manquante n'est pas devinée", async () => {
    const t = Date.now();
    expect(await executePowerTool("read_calendar", { du: ymd(new Date(t - 30 * JOUR)) }, acteur!)).toMatch(/Période incomplète/i);
    expect(await executePowerTool("read_calendar", { au: ymd(new Date(t)) }, acteur!)).toMatch(/Période incomplète/i);
  });

  it("refuse une période inversée, illisible ou démesurée — en le disant", async () => {
    expect(await executePowerTool("read_calendar", { du: "2026-03-10", au: "2026-03-01" }, acteur!)).toMatch(/Période vide/i);
    expect(await executePowerTool("read_calendar", { du: "10/03/2026", au: "2026-03-11" }, acteur!)).toMatch(/illisible/i);
    expect(await executePowerTool("read_calendar", { du: "2020-01-01", au: "2026-01-01" }, acteur!)).toMatch(/trop large/i);
  });

  it("un JOUR précis et « la suite » continuent de marcher", async () => {
    const t = Date.now();
    const jour = await executePowerTool("read_calendar", { date: ymd(new Date(t - 10 * JOUR)) }, acteur!);
    expect(jour).toContain(`${PREFIXE} comité passé`);
    // Sans argument : les prochains événements. Le jeu d'essai n'en pose aucun dans le futur,
    // donc la phrase attendue est celle du futur, pas celle de la période.
    const suite = await executePowerTool("read_calendar", {}, acteur!);
    expect(suite).toBeTruthy();
    expect(String(suite)).not.toContain("total_heures");
  });
});
