import type {
  MailProvider, MailFolder, MailSummary, MailMessage, MailPage, MailDelta, MailDraftInput, MailAddress,
  WellKnownFolder,
} from "../provider";
import { MailError } from "../provider";
import { graphJson, graphBinary } from "./client";
import { toFolder, toSummary, toMessage, skipToken, deltaToken, isRemoved } from "./map";
import { exigerSortieAutorisee } from "@/lib/sortie/garde";
import { noterEffetExterne } from "@/lib/effets/magasin";
import { sansBloquer } from "@/lib/journal";

/**
 * MICROSOFT GRAPH, DERRIÈRE LE CONTRAT.
 *
 * Toutes les requêtes portent sur `/me/…` : le jeton délégué DÉSIGNE la boîte, on ne la nomme
 * jamais. C'est ce qui rend impossible, structurellement, d'atteindre la boîte de quelqu'un
 * d'autre — il n'y a pas d'identifiant de boîte à falsifier, nulle part.
 *
 * `$select` est systématique : demander tous les champs d'un message rapatrie le corps complet
 * pour dessiner une ligne de liste, ce qui multiplie le temps de chargement d'une boîte par dix.
 */

type Raw = Record<string, any>;

const LIST_FIELDS = "id,conversationId,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,hasAttachments,isDraft,parentFolderId";
const MESSAGE_FIELDS = `${LIST_FIELDS},ccRecipients,bccRecipients,replyTo,body,webLink,sentDateTime`;
const DEFAULT_PAGE = 40;

/**
 * LES NOMS RÉSERVÉS de Graph v1.0 → notre vocabulaire.
 *
 * `GET /me/mailFolders/inbox` rend le dossier Réception quel que soit son nom affiché — ces noms
 * sont indépendants de la langue de la boîte. C'est le SEUL moyen fiable en v1.0 de savoir quel
 * dossier joue quel rôle : la propriété `wellKnownName` n'existe qu'en version bêta, et le nom
 * affiché d'une boîte française (« Éléments envoyés ») ne ressemble à aucun nom Graph.
 */
const WELL_KNOWN_PATHS: readonly (readonly [string, WellKnownFolder])[] = [
  ["inbox", "inbox"],
  ["sentitems", "sent"],
  ["drafts", "drafts"],
  ["archive", "archive"],
  ["deleteditems", "trash"],
  ["junkemail", "junk"],
];

/**
 * Les dossiers SYSTÈME qu'aucune messagerie n'affiche : « Boîte d'envoi » n'est que la file
 * d'attente technique d'Exchange (un message y passe deux secondes avant de partir), et
 * « Historique des conversations » est un dépôt Teams/Skype. Les montrer fait chercher des
 * messages là où il n'y en a jamais. Résolus eux aussi par nom réservé — donc masqués quelle que
 * soit la langue de la boîte.
 */
const HIDDEN_PATHS = ["outbox", "conversationhistory"] as const;

const recipients = (list: readonly MailAddress[] | undefined) =>
  (list ?? []).map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

function draftBody(input: MailDraftInput): Raw {
  return {
    subject: input.subject,
    body: { contentType: "HTML", content: input.bodyHtml },
    toRecipients: recipients(input.to),
    ccRecipients: recipients(input.cc),
    bccRecipients: recipients(input.bcc),
  };
}

export class MicrosoftGraphMailProvider implements MailProvider {
  constructor(private readonly accessToken: string, private readonly mailboxAddress: string) {}

  private get token() { return this.accessToken; }

  async address(): Promise<string> {
    return this.mailboxAddress;
  }

  async listFolders(): Promise<MailFolder[]> {
    // 100 dossiers couvre très largement une boîte professionnelle ; au-delà, la colonne de
    // gauche cesse d'être lisible bien avant que la limite ne gêne.
    //
    // `wellKnownName` N'EST PAS dans le `$select`, et ce n'est pas un oubli : la propriété
    // n'existe qu'en version bêta de Graph. En v1.0, la nommer fait répondre 400 BadRequest à
    // TOUTE la requête — c'est la panne qui affichait « La messagerie n'a pas pu répondre » à
    // l'ouverture, alors que l'envoi, lui, fonctionnait.
    const listP = graphJson<{ value: Raw[] }>({
      accessToken: this.token,
      path: "/me/mailFolders",
      query: { $top: 100, $select: "id,displayName,parentFolderId,unreadItemCount,totalItemCount" },
    });

    // L'identifiant d'un dossier à nom réservé — toléré en échec : une boîte sans dossier Archive
    // doit afficher sa liste, pas un bandeau d'erreur. Un rôle introuvable laisse simplement le
    // dossier s'afficher sous son propre nom.
    const resolveId = async (path: string): Promise<string> => {
      const f = await graphJson<Raw>({
        accessToken: this.token,
        path: `/me/mailFolders/${path}`,
        query: { $select: "id" },
      }).catch(sansBloquer("provider.resolveId.graphJson", null));
      return String(f?.id ?? "");
    };

    // Les rôles et les dossiers à masquer, par les noms réservés — huit lectures en parallèle.
    const knownP = Promise.all(
      WELL_KNOWN_PATHS.map(async ([path, role]) => {
        const id = await resolveId(path);
        return id ? ([id, role] as const) : null;
      }),
    );
    const hiddenP = Promise.all(HIDDEN_PATHS.map(resolveId));

    const [list, pairs, hiddenIds] = await Promise.all([listP, knownP, hiddenP]);
    const wellKnownById = new Map(pairs.filter((p): p is readonly [string, WellKnownFolder] => p !== null));
    const hidden = new Set(hiddenIds.filter(Boolean));
    return (list.value ?? [])
      // Le dossier masqué ET ses éventuels sous-dossiers : un enfant orphelin d'un parent invisible
      // apparaîtrait comme un dossier personnel sans explication.
      .filter((raw) => !hidden.has(String(raw.id ?? "")) && !hidden.has(String(raw.parentFolderId ?? "")))
      .map((raw) => toFolder(raw, wellKnownById));
  }

  async listMessages(opts: { folderId: string; cursor?: string | null; limit?: number; search?: string | null }): Promise<MailPage<MailSummary>> {
    const top = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 5), 100);
    const search = opts.search?.trim();

    // Graph refuse `$orderby` avec `$search` — les combiner rend une erreur qui ne dit pas
    // pourquoi. Une recherche est déjà classée par pertinence, ce qui est le bon ordre ici.
    const query: Record<string, string | number | undefined> = {
      $top: top,
      $select: LIST_FIELDS,
      ...(search ? { $search: `"${search.replace(/"/g, "")}"` } : { $orderby: "receivedDateTime desc" }),
      ...(opts.cursor ? { $skiptoken: opts.cursor } : {}),
    };

    const json = await graphJson<{ value: Raw[]; "@odata.nextLink"?: string }>({
      accessToken: this.token,
      path: `/me/mailFolders/${encodeURIComponent(opts.folderId)}/messages`,
      query,
    });
    return {
      items: (json.value ?? []).map(toSummary),
      nextCursor: skipToken(json["@odata.nextLink"]),
    };
  }

  async getMessage(id: string): Promise<MailMessage> {
    const [msg, atts] = await Promise.all([
      graphJson<Raw>({ accessToken: this.token, path: `/me/messages/${encodeURIComponent(id)}`, query: { $select: MESSAGE_FIELDS } }),
      graphJson<{ value: Raw[] }>({
        accessToken: this.token,
        path: `/me/messages/${encodeURIComponent(id)}/attachments`,
        query: { $select: "id,name,contentType,size,isInline" },
      }).catch(sansBloquer("provider.getMessage.graphJson", { value: [] as Raw[] })), // un message sans pièce jointe ne doit pas échouer
    ]);
    return toMessage(msg, atts.value ?? []);
  }

  async getConversation(conversationId: string): Promise<MailSummary[]> {
    const json = await graphJson<{ value: Raw[] }>({
      accessToken: this.token,
      path: "/me/messages",
      query: {
        $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
        $select: LIST_FIELDS,
        $orderby: "receivedDateTime asc",
        $top: 50,
      },
    });
    return (json.value ?? []).map(toSummary);
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ name: string; contentType: string; content: Buffer }> {
    const meta = await graphJson<Raw>({
      accessToken: this.token,
      path: `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      query: { $select: "id,name,contentType,size" },
    });
    const bin = await graphBinary({
      accessToken: this.token,
      path: `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    });
    return {
      name: String(meta.name ?? "piece-jointe"),
      // On garde le type déclaré par Graph, pas celui deviné : c'est celui qui sert à choisir la
      // visionneuse. Le service de la pièce, lui, neutralise le type à la sortie.
      contentType: String(meta.contentType ?? bin.contentType),
      content: bin.buffer,
    };
  }

  async createDraft(input: MailDraftInput): Promise<{ id: string }> {
    // Répondre / transférer passe par les points d'entrée dédiés : eux seuls posent les en-têtes
    // `In-Reply-To` et `References`, sans lesquels la réponse casse le fil chez le destinataire.
    if (input.inReplyTo) {
      const { messageId, mode } = input.inReplyTo;
      const verb = mode === "forward" ? "createForward" : mode === "replyAll" ? "createReplyAll" : "createReply";
      const created = await graphJson<Raw>({
        accessToken: this.token, method: "POST",
        path: `/me/messages/${encodeURIComponent(messageId)}/${verb}`,
      });
      const id = String(created.id ?? "");
      if (!id) throw new MailError("unknown", "Le brouillon n'a pas pu être créé.");
      await this.updateDraft(id, { ...input, inReplyTo: null });
      await this.attachAll(id, input);
      return { id };
    }

    const created = await graphJson<Raw>({
      accessToken: this.token, method: "POST", path: "/me/messages", body: draftBody(input),
    });
    const id = String(created.id ?? "");
    if (!id) throw new MailError("unknown", "Le brouillon n'a pas pu être créé.");
    await this.attachAll(id, input);
    return { id };
  }

  async updateDraft(id: string, input: MailDraftInput): Promise<void> {
    await graphJson({
      accessToken: this.token, method: "PATCH",
      path: `/me/messages/${encodeURIComponent(id)}`, body: draftBody(input),
    });
  }

  private async attachAll(draftId: string, input: MailDraftInput): Promise<void> {
    for (const a of input.attachments ?? []) {
      await graphJson({
        accessToken: this.token, method: "POST",
        path: `/me/messages/${encodeURIComponent(draftId)}/attachments`,
        body: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.name,
          contentType: a.contentType,
          contentBytes: a.content.toString("base64"),
        },
      });
    }
  }

  async sendDraft(id: string): Promise<void> {
    await graphJson({ accessToken: this.token, method: "POST", path: `/me/messages/${encodeURIComponent(id)}/send` });
  }

  async send(input: MailDraftInput): Promise<void> {
    // LA GARDE D'ABORD (`sortie/garde.ts`) : le brouillon lui-même est déjà une écriture chez
    // Microsoft, et l'envoi qui suit est irréversible. On refuse AVANT la création du brouillon.
    // LE PORT DE SIMULATION (J7) : un geste simulé note le courriel et ne crée même pas le brouillon.
    if (noterEffetExterne({ acte: "COURRIEL", cible: input.to.map((a) => a.address).join(", ") || "(sans destinataire)", apercu: `« ${input.subject ?? ""} »`, origine: "mail/graph:send" })) return;
    exigerSortieAutorisee("COURRIEL", input.to.map((a) => a.address).join(", ") || "(sans destinataire)", {
      apercu: `« ${input.subject ?? ""} »`,
      origine: "mail/graph:send",
    });
    // On passe TOUJOURS par un brouillon puis `send` : l'envoi direct (`/me/sendMail`) ne laisse
    // aucune trace exploitable en cas d'échec partiel, et ne sait pas répondre dans un fil.
    const { id } = await this.createDraft(input);
    try {
      await this.sendDraft(id);
    } catch (e) {
      // DEUX ÉTAPES, DEUX ÉCHECS TRÈS DIFFÉRENTS — et la personne doit savoir lequel.
      //
      // Échouer sur la création du brouillon ne laisse rien derrière. Échouer sur l'envoi laisse le
      // message COMPLET dans « Brouillons » : le travail de rédaction n'est pas perdu, il suffit de
      // réessayer depuis là. Sans cette phrase, on retape tout — ou pire, on croit le message parti.
      if (e instanceof MailError) {
        throw new MailError(
          e.kind,
          `${e.message} Le message est resté dans vos brouillons : rien n'a été perdu.`,
          e.retryAfterSec,
          e.diagnostic,
        );
      }
      throw e;
    }
  }

  async setRead(id: string, read: boolean): Promise<void> {
    await graphJson({
      accessToken: this.token, method: "PATCH",
      path: `/me/messages/${encodeURIComponent(id)}`, body: { isRead: read },
    });
  }

  async move(id: string, folderId: string): Promise<{ id: string }> {
    // Un déplacement change l'identifiant du message chez Microsoft : le rendre est indispensable,
    // sinon l'écran garde un identifiant mort et la lecture suivante échoue en 404.
    const moved = await graphJson<Raw>({
      accessToken: this.token, method: "POST",
      path: `/me/messages/${encodeURIComponent(id)}/move`, body: { destinationId: folderId },
    });
    return { id: String(moved.id ?? id) };
  }

  async delete(id: string): Promise<void> {
    // « Supprimer » = mettre à la corbeille, comme partout ailleurs. Une suppression définitive
    // sans filet n'a pas sa place dans un client mail d'entreprise.
    await this.move(id, "deleteditems");
  }

  async delta(folderId: string, token: string | null): Promise<MailDelta> {
    const changed: MailSummary[] = [];
    const removedIds: string[] = [];

    let next: string | null = null;
    let link: string | null = null;
    let cursor = token;
    let usedToken = false;

    // Une delta parcourt ses pages jusqu'au bout : s'arrêter à la première laisserait des
    // changements derrière, et le jeton final ne serait pas rendu.
    for (let page = 0; page < 50; page++) {
      const json: Raw = await graphJson<Raw>({
        accessToken: this.token,
        path: `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
        query: {
          $select: LIST_FIELDS,
          ...(next ? { $skiptoken: next } : {}),
          ...(!next && cursor && !usedToken ? { $deltatoken: cursor } : {}),
        },
      });
      usedToken = true;
      cursor = null;

      for (const raw of (json.value ?? []) as Raw[]) {
        if (isRemoved(raw)) removedIds.push(String(raw.id ?? ""));
        else changed.push(toSummary(raw));
      }
      next = skipToken(json["@odata.nextLink"]);
      link = (json["@odata.deltaLink"] as string | undefined) ?? link;
      if (!next) break;
    }

    return { changed, removedIds, deltaToken: deltaToken(link) };
  }
}
