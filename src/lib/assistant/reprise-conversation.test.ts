import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { appendExchange, getThreadMessages, ensurePrimaryThread } from "@/lib/assistant-memory";
import { elaguerFil, lireWorkspaceRange } from "@/lib/assistant/workspace/turn";

// I6 (décision 0070) : l'ancien moteur et ses fils (`AssistantThread`) se testent SOUS SON DRAPEAU — sans lui, ils sont
// gelés en lecture (moteur unique). Le drapeau est posé pour ce fichier seul, puis rendu.
const drapeauAncienMoteur = process.env.ADAM_ANCIEN_MOTEUR;
beforeAll(() => { process.env.ADAM_ANCIEN_MOTEUR = "1"; });
afterAll(() => { if (drapeauAncienMoteur === undefined) delete process.env.ADAM_ANCIEN_MOTEUR; else process.env.ADAM_ANCIEN_MOTEUR = drapeauAncienMoteur; });

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__reprise__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'ADAM CONSTRUIT SURVIT À LA FERMETURE DE L'ONGLET.
 *
 * `AssistantMessage` ne gardait que `role` + `content`. Les blocs de l'espace de travail —
 * tableaux, graphiques, cartes d'action, aperçus de pièces — vivaient dans l'état React et
 * disparaissaient au retour : la personne retrouvait la PHRASE d'Adam et perdait l'écran
 * qu'elle avait sous les yeux. Un tour d'Adam n'est pas une réplique, c'est un écran ; le
 * garder à moitié, c'est ne pas le garder.
 *
 * Le banc part de la MÉMOIRE — le point d'entrée que la conversation et le flux appellent
 * tous les deux — et relit ce qui a été rangé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("REPRISE — un tour rechargé retrouve son écran, pas seulement sa phrase", () => {
  let userId = "", threadId = "";

  const composition = [
    { capability: "read_table", blocks: [{ type: "tableau", titre: "Dossiers Regulatory", lignes: [["REG-1", "Déposé"]] }] },
    { capability: "send_email", blocks: [{ type: "email", destinataire: "Amel", statut: "brouillon" }] },
  ];

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}u`, email: `${TAG}u@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    userId = u.id;
    threadId = await ensurePrimaryThread(userId);
  });

  afterAll(async () => {
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  });

  /** Ce que lit un ÉCRAN : le texte ET ce qui a été construit. */
  const pourEcran = () => getThreadMessages(userId, threadId, undefined, { avecWorkspace: true });

  it("ce qui a été CONSTRUIT est rangé avec le tour, et relu tel quel", async () => {
    expect(await appendExchange(userId, threadId, "montre les dossiers", "Voici.", composition)).toBe(true);
    const relu = await pourEcran();
    expect(relu).not.toBeNull();
    const reponse = relu!.find((m) => m.role === "assistant")!;
    expect(reponse.content).toBe("Voici.");
    expect(reponse.workspace, "l'écran du tour a été perdu : c'est le défaut que ce banc existe pour attraper")
      .toEqual(composition);
  });

  it("SANS le demander, on ne paie pas l'écran — le tour existe, ses blocs ne traversent pas", async () => {
    // LE CAS QUI FERAIT TOMBER CETTE ASSERTION (§118.17) : que le défaut passe à VRAI. Alors la
    // voix temps réel, qui charge soixante tours pour n'en lire que le texte, ferait traverser
    // soixante tableaux et graphiques à chaque ouverture de session — pour les jeter. Le tour
    // relu ici PORTE un espace de travail (le test précédent vient de le vérifier) : ce qui est
    // mesuré est bien le choix de ne pas le sélectionner, pas une absence de donnée.
    const relu = await getThreadMessages(userId, threadId);
    const reponse = relu!.find((m) => m.content === "Voici.")!;
    expect("workspace" in reponse).toBe(false);
  });

  it("un tour SANS écran ne porte pas la clé — absent et vide ne disent pas la même chose", async () => {
    // §118.71 : une clé présente à `null` ferait croire à l'écran qu'un espace de travail
    // existe et qu'il est vide. Ici, il n'y en a pas — et ça se lit.
    await appendExchange(userId, threadId, "bonjour", "Bonjour.");
    const relu = await pourEcran();
    const dernier = relu!.filter((m) => m.role === "assistant").at(-1)!;
    expect(dernier.content).toBe("Bonjour.");
    expect("workspace" in dernier).toBe(false);
  });

  it("LA QUESTION reste du texte — on ne range un écran que sur la RÉPONSE", async () => {
    const relu = await pourEcran();
    for (const m of relu!.filter((x) => x.role === "user")) expect("workspace" in m).toBe(false);
  });

  it("un fil qui n'est pas le mien ne rend RIEN — la reprise n'ouvre pas une porte", async () => {
    const autre = await prisma.user.create({
      data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, role: "VIEWER", passwordHash: "x" },
    });
    expect(await getThreadMessages(autre.id, threadId)).toBeNull();
    expect(await appendExchange(autre.id, threadId, "x", "y", composition)).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI REMONTE DE LA BASE PASSE PAR LE RENDU — et ne doit JAMAIS l'abattre.
 *
 * `lireWorkspaceRange` décide de ce qu'on sait rendre ; `elaguerFil` est ce qui le consomme
 * en premier, et elle parcourt `c.blocks`. Une première version du filtre acceptait tout
 * objet : un enregistrement écrit par une autre version du protocole serait arrivé sans
 * `blocks`, et le fil entier serait tombé sur `undefined.forEach` — pas un bloc manquant, la
 * CONVERSATION en écran blanc, au retour, pour une donnée qu'on ne savait pas lire.
 *
 * Le banc fait donc se RENCONTRER les deux fonctions : vérifier le corps de l'une sans son
 * appelant ne prouverait rien (§118.49). Il n'a pas besoin de base — c'est du calcul pur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("RELECTURE — ce qu'on ne sait pas lire se tait ; il n'abat pas la conversation", () => {
  const bon = { source: "read_table", blocks: [{ kind: "table", blockId: "t1" }] };

  it("un tour valide traverse et garde ses blocs", () => {
    const lu = lireWorkspaceRange([bon]);
    expect(lu).not.toBeNull();
    expect(elaguerFil([lu!])[0]![0]!.blocks).toHaveLength(1);
  });

  for (const [nom, brut] of [
    ["un objet SANS blocs (autre version du protocole)", [{ source: "x" }]],
    ["des blocs qui ne sont pas une liste", [{ source: "x", blocks: { kind: "table" } }]],
    ["du texte au lieu d'une composition", ["une phrase"]],
    ["des nulls", [null, undefined]],
    ["un objet nu au lieu d'une liste", { source: "x", blocks: [] }],
    ["une liste vide", []],
  ] as [string, unknown][]) {
    it(`${nom} : rien à rendre, et RIEN ne casse`, () => {
      const lu = lireWorkspaceRange(brut);
      expect(lu).toBeNull();
      // LE CAS QUI FERAIT TOMBER CETTE ASSERTION : que le filtre laisse passer une forme que
      // le rendu ne sait pas parcourir. `elaguerFil` est exactement ce que l'écran appelle en
      // premier sur le fil relu — c'est donc elle qui doit tenir, pas un test du filtre seul.
      expect(() => elaguerFil([lu ?? []])).not.toThrow();
    });
  }

  it("le VALIDE survit au milieu de l'illisible — on ne jette pas le tour entier", () => {
    const lu = lireWorkspaceRange([{ source: "a" }, bon, "texte"]);
    expect(lu).toHaveLength(1);
    expect(() => elaguerFil([lu!])).not.toThrow();
  });
});
