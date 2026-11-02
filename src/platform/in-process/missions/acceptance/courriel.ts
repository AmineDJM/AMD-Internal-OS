/**
 * Acceptance du Run 4 — §3 E-MAIL : la frontière exacte du fournisseur, du webhook à la
 * conclusion de la mission (ingestion, dédoublonnage, pièce canonique, réveil).
 */
import { prisma } from "@/lib/prisma";
import { ingestMessage } from "@/lib/google/gmail/ingest";
import { sealSecret } from "@/lib/crypto/secret-box";
import { type ContexteAcceptance, attendre, conduire, controle, etatEtape, lecture, planDe } from "./banc";

export async function scenariosCourriel(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, acteur, jouerScenario, lancer } = ctx;
  /* ═══════════════ §3 — E-MAIL : la frontière EXACTE du fournisseur ═══════════════ */

  await jouerScenario("MAIL-1", "EMAIL_PIPELINE", "webhook→ingestion→normalisation→dédup→pièce canonique→EMAIL_RECEIVED→réveil→conclusion", false, async () => {
    const expeditrice = `signataire-${TAG}@exemple.dz`;
    const boite = `adam-${TAG}@amd-acceptance.dz`;
    const fil = `thread-${TAG}`;
    const pieceNom = `contrat-signe-${TAG}.txt`;
    const pieceTexte = `CONTRAT SIGNÉ ${TAG} — les deux parties s'engagent.`;

    // LA CONNEXION — un jeton chiffré par le VRAI coffre, une expiration future : le chemin
    // de production (déchiffrement, court-circuit du refresh) est celui qui tourne.
    const boiteUser = await prisma.user.create({
      data: { name: `${TAG} Boîte`, email: boite, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true },
    });
    const conn = await prisma.googleConnection.create({
      data: {
        userId: boiteUser.id, address: boite, status: "connected",
        accessTokenEnc: sealSecret(`jeton-${TAG}`), expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });

    // LA MISSION QUI ATTEND — lancée AVANT que le courrier n'existe.
    const criteres = ["le contrat est arrivé et analysé"];
    const plan = planDe("Attendre le contrat signé", "S", criteres, [
      lecture("lire"),
      {
        key: "attente", title: "Attendre le contrat de la signataire", nodeType: "WAIT_EVENT", capability: null,
        dependsOn: ["lire"], completionCondition: "le contrat est arrivé",
        waitEvent: "EMAIL_RECEIVED", waitFrom: expeditrice, waitSubject: "contrat", waitAttachment: "contrat*",
      },
      { ...lecture("bilan", ["attente"], 3), title: "Analyser après réception" },
      controle(["bilan"]),
    ]);
    const { missionId, cerveau } = await lancer("Quand la signataire envoie le contrat, analyse et conclus.", plan, criteres, { titre: "gmail" });
    await conduire(acteur, missionId, cerveau);
    attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "la mission n'attend pas");

    // LE FOURNISSEUR — un fetch scellé sur le SEUL hôte gmail.googleapis.com, qui sert la
    // forme réelle de l'API (format=full, pièce en base64url). Tout autre hôte passe au vrai
    // réseau : le reste du run (OpenAI compris) n'est pas touché.
    const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const messages: Record<string, unknown> = {
      [`msg-${TAG}-intrus`]: {
        id: `msg-${TAG}-intrus`, threadId: `${fil}-intrus`, historyId: "1", labelIds: ["INBOX"],
        snippet: "pièce d'un intrus", internalDate: String(Date.now()),
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: `Intrus <intrus-${TAG}@exemple.dz>` },
            { name: "To", value: boite }, { name: "Subject", value: `contrat ${TAG}` },
            { name: "Message-ID", value: `<intrus-${TAG}@exemple.dz>` },
          ],
          parts: [
            { mimeType: "text/plain", body: { size: 20, data: b64url("pièce d'un intrus") } },
            { mimeType: "text/plain", filename: pieceNom, body: { attachmentId: "att-intrus", size: 64 } },
          ],
        },
      },
      [`msg-${TAG}-ok`]: {
        id: `msg-${TAG}-ok`, threadId: fil, historyId: "2", labelIds: ["INBOX"],
        snippet: "le contrat signé", internalDate: String(Date.now()),
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: `Signataire <${expeditrice}>` },
            { name: "To", value: boite }, { name: "Subject", value: `Le contrat ${TAG} signé` },
            { name: "Message-ID", value: `<ok-${TAG}@exemple.dz>` },
          ],
          parts: [
            { mimeType: "text/plain", body: { size: 30, data: b64url("Voici le contrat signé.") } },
            { mimeType: "text/plain", filename: pieceNom, body: { attachmentId: "att-ok", size: pieceTexte.length } },
          ],
        },
      },
    };
    const fetchReel = globalThis.fetch;
    globalThis.fetch = (async (entree: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof entree === "string" ? entree : entree instanceof URL ? entree.toString() : entree.url;
      if (url.includes("gmail.googleapis.com")) {
        const attachment = url.match(/\/messages\/[^/]+\/attachments\//);
        if (attachment) return new Response(JSON.stringify({ data: b64url(pieceTexte), size: pieceTexte.length }), { status: 200 });
        const id = url.match(/\/messages\/([^/?]+)/)?.[1] ?? "";
        const corps = messages[id];
        return corps
          ? new Response(JSON.stringify(corps), { status: 200 })
          : new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      }
      return fetchReel(entree, init);
    }) as typeof fetch;

    try {
      // 1. L'INTRUS d'abord : ingéré, enregistré — mais la mission ne bouge PAS.
      const intrus = await ingestMessage(conn.id, `msg-${TAG}-intrus`, { domains: [] });
      attendre(intrus.status === "ingested", `l'ingestion de l'intrus a échoué : ${intrus.reason ?? intrus.status}`);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING",
        "le courrier du MAUVAIS expéditeur a réveillé la mission");

      // 2. LE BON : tout le pipeline, de l'identifiant fournisseur à la conclusion.
      const ok = await ingestMessage(conn.id, `msg-${TAG}-ok`, { domains: [] });
      attendre(ok.status === "ingested" && ok.emailRecordId, `l'ingestion du bon message a échoué : ${ok.reason ?? ok.status}`);
      const piece = await prisma.emailAttachmentRecord.findFirst({
        where: { emailRecordId: ok.emailRecordId },
        select: { filename: true, extractedText: true },
      });
      attendre(piece?.filename === pieceNom, "la pièce jointe n'a pas de trace canonique");
      attendre((piece.extractedText ?? "").includes("CONTRAT SIGNÉ"),
        "le texte de la pièce n'a pas été EXTRAIT en document canonique");
      attendre((await etatEtape(missionId, "attente"))?.status === "DONE",
        "EMAIL_RECEIVED émis à la frontière n'a pas réveillé la mission qui attendait");

      // 3. LE WEBHOOK REJOUÉ : dupliqué AVANT tout effet — exactly-once structurel.
      const rejeu = await ingestMessage(conn.id, `msg-${TAG}-ok`);
      attendre(rejeu.status === "duplicate", `le rejeu du webhook n'est pas sorti en duplicate (${rejeu.status})`);
      attendre(await prisma.emailRecord.count({ where: { connectionId: conn.id, providerMessageId: `msg-${TAG}-ok` } }) === 1,
        "le rejeu a créé un second enregistrement");

      const statut = await conduire(acteur, missionId, cerveau);
      attendre(statut === "COMPLETED", `après réception, la mission finit en ${statut}`);
    } finally {
      globalThis.fetch = fetchReel;
    }
    return {
      mesures: { messagesIngeres: 2, rejeux: 1, pieceExtraite: true },
      preuve: "payload injecté À LA FRONTIÈRE (format=full réel) : validation, normalisation, dédup, pièce extraite en document canonique, EMAIL_RECEIVED, réveil de LA bonne mission, rejeu inerte, conclusion.",
    };
  });
}
