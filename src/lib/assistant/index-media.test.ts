import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { ensureNodeIndexed } from "@/lib/assistant/document-discovery";
import { putBlob } from "@/lib/drive-storage";
import fs from "node:fs";

/**
 * UN INDEX VIDE N'EST PAS UNE LECTURE — et un média se lit par la PAROLE.
 *
 * LE DÉFAUT MESURÉ, SUR LA CAMPAGNE LIVE. `defi-media-reunion` : trente-deux secondes de parole
 * réelle déposées dans le Drive, un transcripteur qui marche (vérifié : `whisper-1`, 9 segments
 * horodatés), et Adam répond « INCONNU : son contenu audio n'est pas transcrit ni lisible par
 * les capacités connectées ».
 *
 * La chaîne, mesurée en base : le dépôt écrit une ligne d'index avec un texte VIDE et AUCUNE
 * note — l'extraction d'octets ne sait rien tirer d'un `.mp3`. Le cache la rendait alors comme
 * `{ text: null, note: null }`, c'est-à-dire, pour tout appelant, « lu, il n'y a rien dedans ».
 * Donc : la découverte par CONTENU ne pouvait pas trouver l'enregistrement, la pré-lecture a lu
 * un autre document, et Adam a répondu honnêtement sur ce qu'on lui avait donné. C'est §104.15
 * mot pour mot — « répondre « lu, rien dedans » ferait conclure que le tampon est vierge alors
 * que RIEN n'a été tenté ».
 *
 * CE QUE CE BANC EXERCE, ET CE QU'IL N'EXERCE PAS. Il exerce la LOGIQUE de cache et la RAISON
 * obligatoire, par le vrai point d'entrée (`ensureNodeIndexed`, la porte de l'ingestion), sans
 * fournisseur. Il n'exerce PAS la transcription elle-même : elle exige un moteur de parole,
 * absent d'une suite unitaire. Elle a été mesurée LIVE sur la pièce de la campagne — index 0 →
 * 605 caractères, note « Transcription whisper-1 — 00:32, 9 segment(s) horodatés », transcript
 * persisté, et trouvable par le contenu « budget marketing ». Le dire ici plutôt que de le
 * taire : laisser croire à une vérification qui n'a pas eu lieu serait le faux succès appliqué
 * à son propre travail (§118.82).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__idxmedia__${Date.now()}`;
let ownerId = "";

async function deposer(nom: string, mimeType: string, octets: Buffer): Promise<{ nodeId: string; versionId: string }> {
  const blob = await putBlob(octets);
  const n = await prisma.driveNode.create({ data: { name: nom, type: "FILE", ownerId, createdById: ownerId, mimeType, size: octets.length }, select: { id: true } });
  const v = await prisma.fileVersion.create({ data: { nodeId: n.id, blobId: blob.blobId, version: 1, size: octets.length, mimeType, createdById: ownerId }, select: { id: true } });
  return { nodeId: n.id, versionId: v.id };
}

suite("l'index de contenu ne confond jamais « rien lu » et « rien dedans »", () => {
  beforeAll(async () => {
    // Un simple propriétaire suffit. En SUPER_ADMIN, le compte était désigné valideur par les circuits des bancs voisins
    // (mesuré, F1 : `ValidationStep_validatorId_fkey` refusait son retrait ; 77 notifications de rôle par passage).
    const u = await prisma.user.create({ data: { name: `${TAG} pdg`, email: `${TAG}@t.dz`, passwordHash: "x", role: "VIEWER" } });
    ownerId = u.id;
  });
  afterAll(async () => {
    const noeuds = await prisma.driveNode.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = noeuds.map((n) => n.id);
    await prisma.driveTextIndex.deleteMany({ where: { nodeId: { in: ids } } }).catch(() => {});
    await prisma.mediaTranscript.deleteMany({ where: { nodeId: { in: ids } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { nodeId: { in: ids } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { id: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un texte vide est indexé AVEC sa raison — jamais un silence", async () => {
    // CE QUI LE FERAIT TOMBER : réécrire `note: null` sur un texte vide. La ligne se relirait
    // alors comme « lu, rien dedans », et le prochain lecteur croirait le fichier vide.
    const { nodeId } = await deposer(`${TAG} scan.pdf`, "application/pdf", Buffer.from("pas un vrai pdf"));
    await ensureNodeIndexed(nodeId);
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { text: true, note: true } });
    expect(row, "une ligne d'index doit exister, même sur un échec de lecture").toBeTruthy();
    expect(row!.text.trim()).toBe("");
    expect((row!.note ?? "").trim(), "un texte vide SANS raison est le faux succès qu'on ferme").not.toBe("");
  }, 30_000);

  it("la raison NOMME le format : un média muet et un scan sans OCR n'appellent pas le même geste", async () => {
    const { nodeId } = await deposer(`${TAG} silence.mp3`, "audio/mpeg", Buffer.from("pas un vrai mp3"));
    await ensureNodeIndexed(nodeId);
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { note: true } });
    // Le moteur de parole est absent d'une suite unitaire : la transcription échoue, on retombe
    // sur les octets, et la raison doit dire QUE C'EST UN MÉDIA — sinon on renvoie une personne
    // vers un OCR pour un fichier audio. MESURÉ : c'est `extractAttachmentText` qui la fournit
    // (« Audio / vidéo non transcrit : … »), et elle est déjà juste — le repli `raisonIllisible`
    // ne sert que si la lecture ne dit RIEN du tout.
    expect(row?.note ?? "", "la raison d'un média nomme la parole, pas l'OCR").toMatch(/audio|vid[ée]o|m[ée]dia|parole|transcri/i);
    expect(row?.note ?? "", "et elle ne renvoie pas vers un OCR, qui ne lit pas du son").not.toMatch(/scan sans OCR/i);
  }, 30_000);

  it("un index vide SANS raison n'est pas honoré : on RE-TENTE au lieu de rendre « rien »", async () => {
    // C'est l'état EXACT que la campagne a rencontré : une ligne semée avec un texte vide et
    // aucune note. Après passage par la porte d'ingestion, la ligne doit porter une raison —
    // preuve que le cache n'a pas été servi tel quel.
    const { nodeId, versionId } = await deposer(`${TAG} repas.pdf`, "application/pdf", Buffer.from("x"));
    await prisma.driveTextIndex.create({ data: { nodeId, versionId, text: "", textFold: "" } });
    await ensureNodeIndexed(nodeId);
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { note: true } });
    expect((row?.note ?? "").trim(), "le vide sans raison a été relu, pas servi").not.toBe("");
  }, 30_000);

  it("un index vide AVEC sa raison est un ACQUIS : on ne repaie pas un scan illisible à chaque lecture", async () => {
    // La moitié qui compte : sans elle, chaque lecture d'un scan illisible relancerait
    // l'extraction — un coût permanent pour un résultat connu.
    const { nodeId, versionId } = await deposer(`${TAG} connu.pdf`, "application/pdf", Buffer.from("y"));
    await prisma.driveTextIndex.create({ data: { nodeId, versionId, text: "", textFold: "", note: "RAISON-TEMOIN" } });
    await ensureNodeIndexed(nodeId);
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { note: true } });
    expect(row?.note, "une raison déjà connue n'est pas réécrite").toBe("RAISON-TEMOIN");
  }, 30_000);
  /**
   * ── LE MÉCANISME QUE LA SUITE NE PEUT PAS EXERCER, ON CHERCHE SON POINT D'APPEL ─────────
   *
   * Sabotage joué : retirer le routage du média vers le transcripteur ne faisait tomber AUCUN
   * test — la suite n'a pas de moteur de parole, donc le routage y est un non-événement de
   * toute façon. Une garde qu'on ne peut pas faire échouer est une décoration (§118.17), et la
   * réponse de la doctrine est connue : un test d'architecture qui affirme qu'un mécanisme
   * existe doit chercher son POINT D'APPEL, à l'endroit exact où il doit être (§118.49).
   *
   * Ce qui le ferait tomber : perdre l'appel dans une édition — c'est-à-dire ramener les
   * enregistrements à un index vide, donc introuvables par leur contenu, pour toujours.
   */
  it("le routage du média vers la parole est APPELÉ dans le chemin d'indexation", () => {
    const src = fs.readFileSync("src/lib/assistant/document-discovery.ts", "utf8");
    const i = src.indexOf("async function nodeText(");
    expect(i, "`nodeText` est LE point où toutes les lectures d'un nœud passent").toBeGreaterThan(0);
    const corps = src.slice(i, src.indexOf("\n}", i));
    expect(corps, "un média doit être routé vers le transcripteur AVANT la lecture d'octets").toContain("texteDeMedia(nodeId, node.name)");
    const j = corps.indexOf("texteDeMedia(nodeId, node.name)");
    const k = corps.indexOf("extractAttachmentText(node.name, bytes)");
    expect(k, "la lecture d'octets reste le repli, elle ne disparaît pas").toBeGreaterThan(0);
    expect(j, "la parole d'abord, les octets ensuite : l'ordre EST la réparation").toBeLessThan(k);
    // Et le transcripteur appelé est celui qui PERSISTE — pas une seconde transcription
    // oublieuse à côté de la première (§118.94).
    expect(src).toContain("transcrireMediaDrive");
  });
  it("la garde est chez l'ÉCRIVAIN : n'importe quel appelant qui écrit un vide reçoit sa raison", async () => {
    /**
     * §118.58 : quand un défaut se répète, chercher l'endroit où TOUTES les instances passent.
     * `read_document` écrivait `note ?? null`, le dépôt d'une pièce écrit un texte vide sans
     * note, l'ingestion planifiée passe par ici aussi — trois écrivains, un seul funnel.
     *
     * CE QUI LE FERAIT TOMBER : remettre `note ?? null` dans `indexDriveNodeText`. Un futur
     * appelant écrirait de nouveau une ligne muette, et le document redeviendrait introuvable
     * par son contenu, en silence.
     */
    const { indexDriveNodeText } = await import("@/lib/assistant/document-discovery");
    const { nodeId, versionId } = await deposer(`${TAG} muet.mp3`, "audio/mpeg", Buffer.from("z"));
    // L'appel EXACT que faisait le dépôt du banc : texte vide, aucune note.
    await indexDriveNodeText(nodeId, versionId, "", null, `${TAG} muet.mp3`);
    const row = await prisma.driveTextIndex.findUnique({ where: { nodeId }, select: { note: true } });
    expect((row?.note ?? "").trim(), "aucune ligne vide ne sort d'ici sans raison").not.toBe("");
    expect(row?.note ?? "", "et la raison nomme le format").toMatch(/m[ée]dia|parole/i);
  }, 30_000);
});
