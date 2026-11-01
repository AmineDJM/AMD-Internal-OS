import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E } from "./global-setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR DE CONVERSATION (lot O1, décision 0046) — serveur RÉEL, mode app (`/ia`), au bureau et sur iPhone 13.
 *
 *   • ORAL : la connexion GPT-Live est remplacée dans le navigateur (le média WebRTC ne passe pas le conteneur) ; le
 *     canal d'événements est piloté par le test, d'après la documentation (fragments de transcription horodatés,
 *     `session.delegation.created`). Tout le reste est RÉEL : nos routes, le fil, la base. On vérifie que la question
 *     utile vient de l'agenda (« Excel ou PDF ? »), que le résultat arrivé pendant qu'elle attend n'est PAS dit, et que
 *     la réponse de la personne passe d'abord (« Noté, PDF ») puis enchaîne — sans « j'attends ».
 *   • ÉCRIT : un travail long en cours (le décor est posé en base : aucun appel de modèle dans cette suite) — la
 *     question de l'agenda dans le fil avec ses choix, le résultat TENU, le choix touché qui lève la question.
 * 0 erreur console ; aucune barre de défilement horizontale.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
test.use({
  permissions: ["microphone"],
  launchOptions: {
    executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const prisma = new PrismaClient();
const fils: string[] = [];
test.afterAll(async () => {
  await prisma.assistantIaAgenda.deleteMany({ where: { filId: { in: fils } } });
  await prisma.assistantIaFil.deleteMany({ where: { id: { in: fils } } });
  await prisma.assistantIaVoixTravail.deleteMany({ where: { session: { startsWith: "live_e2e_o1_" } } });
  await prisma.assistantIaVoixSession.deleteMany({ where: { id: { startsWith: "live_e2e_o1_" } } });
  await prisma.$disconnect();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(E2E.superAdminEmail);
  await page.getByLabel(/mot de passe/i).fill(E2E.password);
  await page.getByRole("button", { name: /connexion|se connecter/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Le faux GPT-Live du navigateur : la connexion réussit, le canal d'événements est piloté par `window.__voix`. */
function fauxGptLive() {
  type Canal = { readyState: string; onmessage: ((m: { data: string }) => void) | null; onclose: (() => void) | null; send: (s: string) => void; close: () => void };
  const etat = { envoyes: [] as Record<string, unknown>[], canal: null as Canal | null };
  (window as unknown as { __voix: unknown }).__voix = { etat, emettre: (e: Record<string, unknown>) => etat.canal?.onmessage?.({ data: JSON.stringify(e) }) };
  class FauxPc {
    iceGatheringState = "complete";
    localDescription: { sdp: string } | null = null;
    ontrack: unknown = null;
    addTrack() {}
    addEventListener() {}
    removeEventListener() {}
    createDataChannel() {
      const c: Canal = { readyState: "open", onmessage: null, onclose: null, send: (s) => etat.envoyes.push(JSON.parse(s)), close: () => { c.readyState = "closed"; } };
      etat.canal = c;
      return c;
    }
    async createOffer() { return { type: "offer", sdp: "v=0 offre-e2e" }; }
    async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
    async setRemoteDescription() {}
    close() {}
  }
  (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FauxPc;
}

const commentaires = (page: Page) => page.evaluate(() => (window as unknown as { __voix: { etat: { envoyes: { type: string; content?: string }[] } } }).__voix.etat.envoyes
  .filter((e) => e.type === "session.commentary.append").map((e) => String(e.content ?? "")));

const ECRANS = [{ nom: "bureau", largeur: 1440, hauteur: 900 }, { nom: "iphone13", largeur: 390, hauteur: 844 }] as const;

for (const ecran of ECRANS) {
  test(`O1 oral (${ecran.nom}) — la question de l'agenda n'est jamais coupée par un résultat ; la réponse passe d'abord`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: ecran.largeur, height: ecran.hauteur });
    const erreurs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
    page.on("pageerror", (e) => erreurs.push(e.message));
    await page.addInitScript(fauxGptLive);
    const moi = await prisma.user.findUniqueOrThrow({ where: { email: E2E.superAdminEmail }, select: { id: true } });
    const session = `live_e2e_o1_${ecran.nom}_${Date.now().toString(36)}`;
    await prisma.assistantIaVoixSession.create({ data: { id: session, userId: moi.id } });
    await page.route("**/api/assistant-ia/voix/session", (r) => r.fulfill({ status: 201, json: { session, sdp: "v=0 reponse-e2e", modele: "gpt-live-1", reprises: [] } }));

    await login(page);
    await page.goto("/ia");
    await expect(page.getByTestId("accueil")).toBeVisible({ timeout: 30_000 });
    const panneau = page.getByRole("dialog", { name: "Conversation vocale" });
    await expect(async () => {
      await page.getByTestId("voix-temps-reel").first().click();
      await expect(panneau).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await panneau.getByRole("button", { name: /Appeler l'assistant|Parler à l'assistant/ }).click();
    await page.waitForFunction(() => !!(window as unknown as { __voix: { etat: { canal: unknown } } }).__voix.etat.canal);
    const emettre = (e: Record<string, unknown>) => page.evaluate((x) => (window as unknown as { __voix: { emettre: (e: unknown) => void } }).__voix.emettre(x), e);
    await emettre({ type: "session.started", session: { id: session } });
    await emettre({ type: "session.input_transcript.delta", delta: "Prépare-moi un rapport des ventes par wilaya", start_ms: 0, end_ms: 1800 });
    await emettre({ type: "session.delegation.created", delegation: { id: "deleg_1", target: "client" } });

    // L'accusé, collé à LA question utile, dérivée de la demande.
    await expect.poll(async () => (await commentaires(page))[0] ?? "", { timeout: 20_000 }).toMatch(/préviens dès que c'est prêt.*Excel ou PDF \?/s);
    await emettre({ type: "session.output_transcript.delta", delta: "Je regarde et je te préviens. Tu préfères un rendu Excel ou PDF ?", start_ms: 2000, end_ms: 5200 });

    // Le travail aboutit (ici en échec : aucun modèle dans cette suite) PENDANT que la question attend : rien n'est dit.
    await expect.poll(async () => (await prisma.assistantIaVoixTravail.findFirst({ where: { session } }))?.tourId ?? null, { timeout: 20_000 }).not.toBeNull();
    const w = await prisma.assistantIaVoixTravail.findFirstOrThrow({ where: { session } });
    await expect.poll(async () => (await prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant", etat: { in: ["TERMINE", "ECHEC"] } } }))?.id ?? null, { timeout: 120_000 }).not.toBeNull();
    await page.waitForTimeout(4_000);
    expect(await commentaires(page)).toHaveLength(1);
    await page.screenshot({ path: `e2e-screenshots/o1-oral-${ecran.nom}-1-question-tenue.png` });

    // « En PDF » : l'accusé d'abord, puis la question suivante — pas le résultat dépassé, pas « j'attends ».
    await emettre({ type: "session.input_transcript.delta", delta: "En PDF", start_ms: 9000, end_ms: 9700 });
    await emettre({ type: "session.delegation.created", delegation: { id: "deleg_2", target: "client" } });
    await expect.poll(async () => (await commentaires(page))[1] ?? "", { timeout: 20_000 }).toMatch(/Noté, PDF/);
    const suite = (await commentaires(page))[1];
    // La forme (PDF) est une précision MINEURE : le résultat tenu n'est pas caduc — il est donné juste après la réponse.
    expect(suite).toMatch(/Noté, PDF.*(Et justement|n'a pas abouti)/s);
    expect(suite).not.toMatch(/j'attends/);
    await page.screenshot({ path: `e2e-screenshots/o1-oral-${ecran.nom}-2-accuse.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await panneau.getByRole("button", { name: "Raccrocher" }).click();
    expect(erreurs, erreurs.join("\n")).toEqual([]);
  });

  test(`O1 écrit (${ecran.nom}) — la question de l'agenda dans le fil, le résultat tenu, le choix touché (mineur) qui lève la question sans relance`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: ecran.largeur, height: ecran.hauteur });
    const erreurs: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") erreurs.push(m.text()); });
    page.on("pageerror", (e) => erreurs.push(e.message));
    const moi = await prisma.user.findUniqueOrThrow({ where: { email: E2E.superAdminEmail }, select: { id: true } });
    // LE DÉCOR : un travail long en cours (sa réponse s'écrit depuis 10 s) ; le fil est « tenu » — aucun modèle ne joue.
    const fil = await prisma.assistantIaFil.create({ data: { userId: moi.id, titre: `__e2e__ O1 ${ecran.nom}`, titreSource: "manuel", traitementLe: new Date(), depuisLe: new Date(Date.now() - 60_000) } });
    fils.push(fil.id);
    const q = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: moi.id, role: "user", contenu: "Prépare-moi un rapport des ventes par wilaya", etat: "EN_COURS", createdAt: new Date(Date.now() - 11_000) } });
    const r = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: moi.id, role: "assistant", contenu: "", etat: "EN_COURS", repondA: q.id, etapes: ["Ventes lues"], createdAt: new Date(Date.now() - 10_000) } });

    await login(page);
    await page.goto(`/ia?c=${fil.id}`);
    const question = page.getByTestId("question-agenda");
    await expect(question).toBeVisible({ timeout: 30_000 });
    await expect(question).toContainText("Excel ou PDF");
    await expect(page.getByTestId("avancement-travail")).toContainText("1 étape faite");
    await page.screenshot({ path: `e2e-screenshots/o1-ecrit-${ecran.nom}-1-question.png` });

    // Le résultat arrive pendant que la question attend : il est TENU, pas affiché par-dessus.
    await prisma.assistantIaTour.update({ where: { id: r.id }, data: { etat: "TERMINE", contenu: "Voici le rapport des ventes par wilaya, en tableau." } });
    await expect(page.getByTestId("resultat-tenu")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Voici le rapport des ventes par wilaya, en tableau.")).toHaveCount(0);
    await page.screenshot({ path: `e2e-screenshots/o1-ecrit-${ecran.nom}-2-tenu.png` });

    // « PDF » d'un toucher — une précision MINEURE : la question est levée, la réponse s'affiche telle quelle (elle n'est
    // pas « version d'avant ») et la version PDF se prépare d'après elle, sans refaire la recherche.
    await question.getByRole("button", { name: "PDF" }).click();
    await expect(page.getByTestId("question-agenda")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText("Voici le rapport des ventes par wilaya, en tableau.")).toBeVisible();
    await expect(page.getByTestId("reponse-ajustee")).toHaveCount(0);
    await expect(page.getByTestId("precision-transmise")).toContainText("Mise en forme demandée");
    await expect(page.getByTestId("precision-transmise")).toContainText("Format de rendu voulu : PDF");
    await page.screenshot({ path: `e2e-screenshots/o1-ecrit-${ecran.nom}-3-repondu.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(erreurs, erreurs.join("\n")).toEqual([]);
  });
}
