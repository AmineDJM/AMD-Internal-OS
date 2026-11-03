import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool, powerToolsFor } from "@/lib/assistant/power-tools";
import { assistantToolsFor } from "@/lib/assistant";
import { composeWorkspace } from "@/lib/assistant/workspace/compose";
import { PLUGINS } from "@/lib/skills/plugins";
import { __configurerPourTests, creerMicroSkill, prechargerCapacitesDynamiques } from "./index";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTERFACE SUIT-ELLE LES CAPACITÉS ILLIMITÉES ? — mesuré, pas affirmé.
 *
 * ── LE DÉFAUT ───────────────────────────────────────────────────────────────────────────
 *
 * `composeWorkspace` traduit une sortie d'outil en blocs typés, et sa table est FERMÉE : cinq
 * entrées, tous des outils écrits DANS LE CŒUR. Une capacité DYNAMIQUE n'y figurera jamais —
 * connecteur déclaré par manifeste, micro-outil créé par Adam dans le tour, playbook enseigné —
 * et il n'existe AUCUN endroit où aller ajouter l'entrée manquante : c'est ce qui rend un
 * runtime de skills extensible (§118.58). Treize capacités déclarées, dont deux qui rendent des
 * LISTES (`hubspot_search_contacts`, `pch_appels_d_offres`), ne pouvaient donc rien afficher.
 * En silence : `composeWorkspace` rend `null`, l'écran ne dessine rien, aucune erreur.
 *
 * ── CE QUE CE BANC VÉRIFIE, ET PAR OÙ IL PASSE ──────────────────────────────────────────
 *
 * Par les VRAIS points d'entrée (§118.14, §118.49) : `executePowerTool` — ce que la conversation
 * exécute — puis `composeWorkspace(nom, sortie)` — ce que l'écran reçoit. Aucun état injecté à
 * la main, aucune déclaration écrite dans le test : la déclaration vient du MANIFESTE.
 *
 * Et les DEUX exécuteurs qu'on peut rendre déterministes ici sont couverts, pas un seul
 * (§118.21) : un CONNECTEUR (HTTP, chez un service tiers simulé) et un MICRO-OUTIL créé par
 * Adam (code dans le bac à sable). Le troisième — le playbook — est couvert par la dérivation
 * de ses clés, vérifiée sur la fiche que le modèle lit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__aff${Date.now().toString(36)}`;
let pdg: CurrentUser;

const TENDERS = [
  { reference: "AO-2026-11", objet: "Oncologie — anticorps monoclonaux", dateLimite: "2026-10-30", lots: 4 },
  { reference: "AO-2026-12", objet: "Antibiothérapie hospitalière", dateLimite: "2026-11-14", lots: 2 },
  { reference: "AO-2026-13", objet: "Vaccins pédiatriques", dateLimite: "2026-12-01", lots: 7 },
];

const fauxFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/tenders")) return new Response(JSON.stringify({ items: TENDERS }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

suite("l'écran suit les capacités qu'on n'a PAS écrites", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} pdg`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    __configurerPourTests({ config: { PCH_BASE_URL: "https://pch.demo.test", PCH_TOKEN: "jeton" }, fetchImpl: fauxFetch });
    await prechargerCapacitesDynamiques(pdg);
  }, 60_000);

  afterAll(async () => {
    __configurerPourTests({ config: null, fetchImpl: null });
    await prisma.adamSkill.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: pdg.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("UN CONNECTEUR déclaré : les lignes du service tiers arrivent à l'écran en TABLEAU, sans une ligne dans le cœur", async () => {
    expect(powerToolsFor(pdg).map((t) => t.name)).toContain("pch_appels_d_offres");
    const brut = await executePowerTool("pch_appels_d_offres", { statut: "OUVERT", limite: 20 }, pdg);
    expect(brut).toBeTruthy();
    const sortie = JSON.parse(brut!);
    expect(sortie.ok).toBe(true);
    // LE TITRE vient du manifeste, pas de ce test. Et le CHEMIN est « resultat » et non
    // « resultat.items » : ce connecteur déclare `reponse: { chemin: "items" }`, donc l'exécuteur
    // HTTP a DÉJÀ extrait la liste — le résultat EST les lignes. Les deux formes existent dans le
    // parc et les deux sont couvertes (la clé déclarée l'est dans `lib/skills/affichage.test.ts`).
    expect(sortie._lignes).toEqual({ titre: "Appels d'offres PCH", chemin: "resultat" });

    const compo = composeWorkspace("pch_appels_d_offres", brut!);
    expect(compo, "avant la réparation, `composeWorkspace` rendait null sur TOUTE capacité dynamique").not.toBeNull();
    const bloc = compo!.blocks[0];
    expect(bloc.kind).toBe("table");
    if (bloc.kind !== "table") return;
    expect(bloc.title).toBe("Appels d'offres PCH");
    expect(bloc.rows).toHaveLength(3);
    // Les colonnes sont celles que PARTAGE la majorité des lignes, la plomberie écartée : c'est
    // `tableFromRows` qui décide, le seul traducteur du dépôt (§118.5).
    expect(bloc.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["reference", "objet", "dateLimite"]));
    expect(bloc.rows[0].cells.reference).toBe("AO-2026-11");
    expect(bloc.columns.find((c) => c.key === "lots")?.numeric).toBe(true);
  }, 60_000);

  it("UN MICRO-OUTIL CRÉÉ PAR ADAM : son schéma de sortie EST sa déclaration — le tableau suit", async () => {
    const cree = await creerMicroSkill(pdg, {
      nom: `${TAG} palier`,
      description: "Découpe un montant en paliers de remise et rend une ligne par palier.",
      code: "const p = data.paliers.map((seuil, i) => ({ palier: i + 1, seuil, remise: lib.round(seuil * 0.02, 2) })); return { lignes: p, total: p.length };",
      entrees: { type: "object", properties: { paliers: { type: "array" } }, required: ["paliers"] },
      exemple: { paliers: [100_000, 250_000] },
      attentes: [{ chemin: "total", op: "egal", valeur: 2 }],
      schema: { forme: "objet", cles: ["lignes", "total"] },
    });
    expect(cree.ok, cree.ok ? "" : `création refusée : ${(cree as { motif: string }).motif}`).toBe(true);
    if (!cree.ok) return;

    await prechargerCapacitesDynamiques(pdg);
    // La fiche que le MODÈLE lit dit désormais ce que la capacité rend — avant, elle ne le
    // savait pas : `sorties` d'un micro-outil ne portait qu'une description.
    const fiche = assistantToolsFor(pdg).find((t) => t.name === cree.outil)?.description ?? "";
    expect(fiche).toContain("Rend : lignes, total.");

    const brut = await executePowerTool(cree.outil, { paliers: [100_000, 250_000, 500_000] }, pdg);
    const sortie = JSON.parse(brut!);
    expect(sortie.ok).toBe(true);
    expect(sortie._lignes).toEqual({ titre: `${TAG} palier`, chemin: "resultat.lignes" });

    const compo = composeWorkspace(cree.outil, brut!);
    expect(compo).not.toBeNull();
    const bloc = compo!.blocks[0];
    expect(bloc.kind).toBe("table");
    if (bloc.kind !== "table") return;
    expect(bloc.rows).toHaveLength(3);
    expect(bloc.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["palier", "seuil", "remise"]));
  }, 90_000);

  it("LE PARC ENTIER : chaque capacité déclarée peut afficher dès que sa clé déclarée porte des lignes", () => {
    /**
     * LA PROPRIÉTÉ MESURÉE : ce que le manifeste DÉCLARE, l'écran doit savoir le montrer. On ne
     * teste pas ce que l'API distante rend un jour donné — on teste le MÉCANISME, uniformément,
     * sur les onze capacités du parc. Ce qui le ferait tomber : refermer le chemin, et les onze
     * tombent ensemble au lieu d'être découvertes une par une en production.
     */
    const rows = [{ a: "x1", b: 1 }, { a: "x2", b: 2 }, { a: "x3", b: 3 }];
    const declarantes = PLUGINS.filter((m) => (m.sorties.cles ?? []).length > 0);
    const affichables = declarantes.filter((m) => {
      const cle = (m.sorties.cles ?? [])[0];
      const brut = JSON.stringify({ ok: true, resultat: { [cle]: rows }, outil: `${m.plugin}_${m.id}`, _lignes: { titre: m.titre, chemin: `resultat.${cle}` } });
      const c = composeWorkspace(`${m.plugin}_${m.id}`, brut);
      return c !== null && c.blocks[0]?.kind === "table";
    });
    console.log(`[affichage] capacités dynamiques déclarées : ${PLUGINS.length} · portant des clés de sortie : ${declarantes.length} · affichables : ${affichables.length}`);
    expect(declarantes.length, "PLANCHER : 13 capacités mesurées le jour de la réparation — il peut monter, jamais descendre en silence").toBeGreaterThanOrEqual(13);
    expect(affichables.length, "une capacité déclarée qui ne peut pas afficher est une promesse non tenue").toBe(declarantes.length);
  });

  it("LE CŒUR N'A PAS BOUGÉ : un outil INCONNU sans déclaration n'affiche toujours RIEN", () => {
    /**
     * LA MOITIÉ QUI COMPTE. Ce n'est pas l'inférence aveugle qu'on a ouverte : six lignes de
     * salaire sont arrivées à l'écran en réponse à « Bonsoir, ça va ? » parce qu'un affichage
     * capable de tout montrer finit par tout montrer. Sans `_lignes` posé par du code serveur
     * qui a LU le manifeste, une sortie inconnue reste du texte.
     */
    const brut = JSON.stringify({ ok: true, resultat: { items: [{ nom: "A", salaire: 900_000 }, { nom: "B", salaire: 750_000 }] } });
    expect(composeWorkspace("un_outil_inconnu", brut)).toBeNull();
    // Et une déclaration MALFORMÉE ne passe pas non plus : titre vide, chemin absent, chemin mort.
    expect(composeWorkspace("x", JSON.stringify({ _lignes: { titre: "", chemin: "resultat" }, resultat: [{ a: 1 }, { a: 2 }] }))).toBeNull();
    expect(composeWorkspace("x", JSON.stringify({ _lignes: { titre: "T" }, resultat: [{ a: 1 }, { a: 2 }] }))).toBeNull();
    expect(composeWorkspace("x", JSON.stringify({ _lignes: { titre: "T", chemin: "resultat.nulle.part" }, resultat: [{ a: 1 }, { a: 2 }] }))).toBeNull();
  });

  it("LA DÉCLARATION VIENT DU MANIFESTE — jamais d'une table de noms d'outils écrite à la main", () => {
    /**
     * §118.73 : une fiche écrite à la main est fausse le jour où quelqu'un ajoute un champ, EN
     * SILENCE. Ce test cherche le POINT D'APPEL (§118.49) : le runtime doit passer `m.sorties.cles`
     * et `m.titre`, et non une liste locale. Ce qui le ferait tomber : quelqu'un remplace la
     * lecture du manifeste par un `Record<string, …>` de noms d'outils — et les capacités qu'Adam
     * crée redeviennent invisibles.
     */
    const src = fs.readFileSync("src/platform/in-process/skills/index.ts", "utf8");
    expect(src).toContain("lignesDeclarees({ titre: m.titre, clesDeclarees: m.sorties.cles, sortie })");
    // Et les deux dérivations qui donnent des clés aux capacités qui n'en déclaraient AUCUNE.
    expect(src).toContain("clesDeclareesDuSchema(r.schemaSortie)");
    expect(src).toContain("clesDeclareesDuGabarit(pb.sortie)");
  });
});
