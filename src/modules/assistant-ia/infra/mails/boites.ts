import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { boiteGmailAdam } from "../operations/envoi-gmail";
import { A_COMPLETER, registreDesCapacites } from "../capacites";
import type { PropositionCarte } from "../operations";
import type { MailVu } from "../../domaine/observation/projecteurs";
import { preparerMails, SCHEMA_MAILS } from "../operations/envoi-gmail";
import { charteDuMail, rendreLeMail, signatureDe } from "./redaction";
import { canalAdamOuvert, OU_RELIER_GMAIL_ADAM } from "../../domaine/mails/canal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MAILS DE BOUT EN BOUT (lot P1, décision 0047) — « Tu as accès à ton Gmail ? » se répond en LISANT l'état des
 * connexions, et « envoie-leur » part par UNE boîte nommée, après la carte « Envoyer ».
 *
 * Direction, 02/11 : « quand je parle de boîte mail, je parle de celle d'ADAM ». La boîte de l'assistant est le GMAIL
 * D'ADAM (l'unique connexion Google, GOOGLE_ADAM_EMAIL), par la machine à états de son écran (opération `envoyer_gmail`,
 * `lib/google/gmail/envoi.ts`), pour le SUPER ADMIN SEUL (P1 bis, `domaine/mails/canal.ts` : pour les autres, ce canal
 * n'existe pas — ni outil, ni description, ni état, ni mot). Elle ne peut pas envoyer : on le DIT, sans se
 * rabattre en silence sur une autre boîte. La boîte MICROSOFT de la personne (`microsoft-mail-actions:sendMessage`,
 * `saveDraft`) ou sa boîte SMTP (`mail-actions:sendMailAction`) servent SEULEMENT si elle le demande (`boite`).
 *
 * Toutes passent par la fenêtre d'annulation (R3 réversible : le bouton suffit, plus de ressaisie). Un BROUILLON
 * seulement si la personne le demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Boite = "gmail_adam" | "microsoft" | "smtp" | "erp";

export interface EtatBoites {
  /** Le Gmail d'Adam — `null` pour quiconque n'est pas Super Admin : l'état n'est même pas lu. */
  gmailAdam: { reliee: boolean; adresse: string | null; envoi: boolean; raison: string | null; ouvertePourToi: true } | null;
  microsoft: { reliee: boolean; adresse: string | null; etat: string | null };
  smtp: { reliee: boolean; adresse: string | null };
  /** La boîte qui enverra par défaut (null : aucune). */
  parDefaut: Boite | null;
}

/** L'ÉTAT DES BOÎTES — lu en base, sans jeton. */
export async function etatDesBoites(user: CurrentUser): Promise<EtatBoites> {
  const adamOuvert = canalAdamOuvert(user);
  const [g, ms, smtp] = await Promise.all([
    adamOuvert ? boiteGmailAdam() : Promise.resolve(null),
    prisma.mailConnection.findUnique({ where: { userId: user.id }, select: { address: true, status: true } }),
    prisma.mailAccount.findUnique({ where: { userId: user.id }, select: { email: true } }),
  ]);
  const gmailAdam = adamOuvert ? { reliee: !!g, adresse: g?.address ?? null, envoi: !!g?.envoi, raison: g?.raison ?? null, ouvertePourToi: true as const } : null;
  const microsoft = { reliee: !!ms && ms.status === "connected", adresse: ms?.address ?? null, etat: ms?.status ?? null };
  // La Direction (et le Super Admin) écrit par la boîte d'ADAM. Les autres (assistante, KAM, réglementaire…) n'écrivent
  // pas au nom d'Adam : par LEUR boîte (Microsoft, puis SMTP), sinon par l'envoi de l'ERP (banc d'audit Q1 : sans cela, le
  // mail restait du texte dans la réponse). P1 bis (ML-09) : la boîte d'Adam pas reliée → REPLI sur l'envoi de l'ERP —
  // la carte est préparée quand même, et la réponse DIT en une phrase que la boîte d'Adam n'est pas reliée (jamais
  // « rien n'est préparé »). Ce n'est pas un repli silencieux : `repliAdam` le porte sur la carte (avertissement, donc observation).
  const parDefaut: Boite | null = gmailAdam
    ? (gmailAdam.envoi ? "gmail_adam" : "erp")
    : microsoft.reliee ? "microsoft" : smtp ? "smtp" : "erp";
  return { gmailAdam, microsoft, smtp: { reliee: !!smtp, adresse: smtp?.email ?? null }, parDefaut };
}

const CAPACITE: Record<"microsoft" | "brouillon" | "smtp" | "erp", string> = {
  microsoft: "microsoft-mail-actions:sendMessage",
  brouillon: "microsoft-mail-actions:saveDraft",
  smtp: "mail-actions:sendMailAction",
  erp: "smart-mail-actions:sendMail",
};
const nomDeCapacite = (id: string): string | undefined => registreDesCapacites().capacites.find((c) => c.id === id)?.outil;
const json = (o: unknown) => JSON.stringify(o);

/**
 * LES CAPACITÉS D'ENVOI DE MAIL ne sont offertes au modèle QUE par `envoyer_mail` (lot I1, audit AU1 C2) : elles restent
 * dans le tour (l'outil les appelle), mais pas dans le catalogue qu'il choisit — l'expéditeur ne change plus parce qu'une
 * capacité de plus bas niveau rendait du texte. Il se change sur demande (`boite`), et la carte l'observe.
 */
export const capacitesDEnvoi = (): Set<string> => new Set(Object.values(CAPACITE).map(nomDeCapacite).filter((n): n is string => !!n));

/**
 * LES OUTILS — `trouver` rend un outil du tour par son nom (les capacités et l'opération Gmail y sont déjà, avec leurs
 * gardes) ; `propositions` est la carte du tour : la carte d'envoi y est renommée « Envoyer par … ».
 */
export function outilsMails(user: CurrentUser, trouver: (nom: string) => PowerTool | undefined, propositions: PropositionCarte[]): PowerTool[] {
  const ouvert = (u: CurrentUser) => u.id === user.id;
  const adam = canalAdamOuvert(user);
  const boitesPermises: Boite[] = adam ? ["gmail_adam", "microsoft", "smtp", "erp"] : ["microsoft", "smtp", "erp"];
  return [
    {
      def: {
        name: "mes_boites_mail",
        description: adam
          ? "LIS les boîtes mail reliées : le Gmail d'Adam (l'unique compte Google de la plateforme), la boîte Microsoft et la boîte SMTP de la personne — reliée ou non, adresse, si l'envoi est possible et laquelle enverra. Pour répondre à « as-tu accès à mon/ton Gmail ? ». Aucun jeton n'est lu."
          : "LIS les boîtes par lesquelles la personne peut envoyer : sa boîte Microsoft, sa boîte SMTP, sinon l'envoi de l'ERP — reliée ou non, adresse, et laquelle enverra. Pour répondre à « as-tu accès à ma boîte ? », « par où partent mes mails ? ». Aucun jeton n'est lu.",
        input_schema: { type: "object", properties: {} },
      },
      allowed: ouvert,
      label: "Boîtes mail lues",
      run: async () => {
        const e = await etatDesBoites(user);
        const { gmailAdam, ...autres } = e;
        return json({
          ...(gmailAdam ? e : autres),
          consigne: e.parDefaut
            ? `Réponds avec cet état, tel quel. Un envoi partira par ${e.parDefaut === "gmail_adam" ? `le Gmail d'Adam (${e.gmailAdam?.adresse})` : e.parDefaut === "microsoft" ? `la boîte Microsoft (${e.microsoft.adresse})` : e.parDefaut === "smtp" ? `la boîte SMTP (${e.smtp.adresse})` : "l'envoi de l'ERP"} après la carte « Envoyer ».${e.gmailAdam && !e.gmailAdam.envoi ? ` La boîte Gmail d'Adam n'est pas reliée (${e.gmailAdam.raison ?? "aucune connexion Google"}) : dis-le, et qu'elle se relie dans ${OU_RELIER_GMAIL_ADAM}.` : ""}`
            : "Aucune boîte ne peut envoyer pour l'instant : dis-le tel quel.",
        });
      },
    },
    {
      def: {
        name: "envoyer_mail",
        description: `ENVOIE des mails après confirmation, sans poser de questions : UNE carte « Envoyer » (aperçu réel du mail), annulable pendant la fenêtre d'annulation. Destinataires par leurs NOMS (l'annuaire les résout ; « toute la direction » aussi) ; objet, ton, signature : choisis-les. Le mail se compose en BLOCS (\`contenu\`) : style « sobre » par défaut, « charte », « texte », ou la charte sur une partie seulement ; HTML libre permis. La sortie rend le mail TEL QU'IL PARTIRA (expéditeur, destinataires, texte, nature du rendu). Un mail par personne quand le contenu lui est propre. ${adam
          ? "Envoi par la boîte Gmail d'Adam (Microsoft ou SMTP seulement sur demande, `boite`)."
          : "Envoi par la boîte de la personne (Microsoft, sinon SMTP), sinon par l'envoi de l'ERP — la boîte est choisie par l'outil."} \`brouillon: true\` SEULEMENT sur demande.`,
        input_schema: {
          type: "object",
          properties: {
            mails: SCHEMA_MAILS,
            societe: { type: "string", description: "La société d'envoi (charte) si la demande la nomme ; sinon celle de la personne." },
            boite: { type: "string", enum: boitesPermises, description: adam ? "Seulement si la personne demande EXPLICITEMENT sa propre boîte (microsoft, smtp) ; sinon le Gmail d'Adam." : "Seulement si la personne demande EXPLICITEMENT une boîte (microsoft, smtp) ; sinon laisse l'outil choisir." },
            brouillon: { type: "boolean", description: "Un brouillon au lieu d'un envoi — seulement sur demande." },
          },
          required: ["mails"],
        },
      },
      allowed: ouvert,
      label: "Mail préparé",
      run: async (e) => {
        const etat = await etatDesBoites(user);
        // Une boîte hors des boîtes permises (le canal d'Adam demandé par un non-Super-Admin) est IGNORÉE : la boîte par défaut.
        const voulue = typeof e.boite === "string" && boitesPermises.includes(e.boite as Boite) ? (e.boite as Boite) : null;
        const brouillon = e.brouillon === true;
        const dispo = (b: Boite) => (b === "gmail_adam" ? !!etat.gmailAdam?.envoi : b === "microsoft" ? etat.microsoft.reliee : b === "smtp" ? etat.smtp.reliee : true);
        const boite: Boite | null = voulue ? (dispo(voulue) ? voulue : null) : etat.parDefaut;
        if (!boite) {
          const raison = voulue ? `La boîte demandée (${voulue}) ne peut pas envoyer.`
            : !etat.gmailAdam ? "Aucune boîte ne peut envoyer pour l'instant."
              : `La boîte Gmail d'Adam ne peut pas envoyer : ${etat.gmailAdam.reliee ? etat.gmailAdam.raison : `elle n'est pas reliée (${OU_RELIER_GMAIL_ADAM})`}.`;
          return json({ statut: "REFUS", raison, ...(etat.gmailAdam ? { etat } : {}), consigne: "Dis-le tel quel ; rien n'est préparé. Ne propose une autre boîte (Microsoft, SMTP de la personne) que si elle te le demande." });
        }
        if (brouillon && (boite === "smtp" || boite === "erp")) return json({ statut: "REFUS", raison: adam ? "Cette boîte ne garde pas de brouillon : Gmail d'Adam ou boîte Microsoft." : "Cette boîte ne garde pas de brouillon : seule une boîte Microsoft reliée le permet." });
        const nom = boite === "gmail_adam" ? "envoyer_gmail" : nomDeCapacite(CAPACITE[brouillon ? "brouillon" : boite]);
        const outil = nom ? trouver(nom) : undefined;
        if (!outil || !outil.allowed(user)) return json({ statut: "REFUS", raison: `L'envoi par cette boîte n'est pas ouvert à ton rôle (${boite}).` });
        let entree: Record<string, unknown>;
        let piecesNonJointes: string[] = [];
        let destinataireACompleter: string | null = null;
        let rendu: MailVu | null = null;
        let formePerdue = false;
        if (boite === "gmail_adam") entree = { mails: e.mails, ...(typeof e.societe === "string" ? { societe: e.societe } : {}), ...(brouillon ? { brouillon: true } : {}) };
        else {
          // La boîte de la personne (sur sa demande) : un mail par carte, le MÊME rendu.
          // F2 (TR-MU-03) : un destinataire introuvable n'arrête pas la carte — il reste « à compléter » sur elle.
          const prep = await preparerMails(Array.isArray(e.mails) ? e.mails.slice(0, 1) : [], undefined, { destinataireACompleter: true });
          if (!("ok" in prep)) return json({ statut: "INCOMPLET", manque: prep.manque, consigne: "Pose UNE seule question : la première de `manque`." });
          const m = prep.mails[0]!;
          // Cette boîte ne joint pas de fichier : la carte part quand même, et la pièce est DITE à joindre à la main.
          if (m.pieces.length) piecesNonJointes = m.pieces;
          const signature = await signatureDe(user);
          const charte = await charteDuMail(user, typeof e.societe === "string" ? e.societe : null, signature);
          const to = m.destinataires.map((d) => d.email).join(", "), cc = m.cc.map((d) => d.email).join(", ");
          // UN rendu (I1, étape 5) — la boîte SMTP ou l'envoi de l'ERP n'envoient que du texte : le HTML n'existe pas, et
          // l'observation le dit (la mise en forme demandée n'est pas conservée par cette boîte).
          const texteSeul = boite !== "microsoft";
          const r = rendreLeMail(m.document, signature, charte, m.objet, { texteSeul });
          if (texteSeul && m.document.style !== "texte") formePerdue = true;
          rendu = { expediteur: boite === "microsoft" ? `${etat.microsoft.adresse} (ta boîte Microsoft)` : boite === "smtp" ? `${etat.smtp.adresse} (ta boîte SMTP)` : "l'envoi de l'ERP", a: m.destinataires.map((d) => (d.nom ? `${d.nom} <${d.email}>` : d.email)), cc: m.cc.map((d) => d.email), objet: m.objet, texte: r.texte, html: r.html };
          entree = boite === "microsoft"
            ? { ...(to ? { to } : {}), ...(cc ? { cc } : {}), subject: m.objet, bodyHtml: r.apercu }
            : { ...(to ? { to } : {}), ...(cc ? { cc } : {}), subject: m.objet, body: r.texte };
          if (m.aCompleter) {
            destinataireACompleter = m.aCompleter;
            Object.assign(entree, { [A_COMPLETER]: ["to"] });
          }
          // Une boîte de la personne : un mail par carte — le second se prépare au tour suivant (une carte par tour).
        }
        const avant = propositions.length;
        const sortie = await outil.run(entree, user);
        const adresse = boite === "gmail_adam" ? etat.gmailAdam?.adresse ?? null : boite === "microsoft" ? etat.microsoft.adresse : etat.smtp.adresse;
        const dite = boite === "gmail_adam" ? `le Gmail d'Adam (${adresse})` : boite === "microsoft" ? `ta boîte Microsoft (${adresse})` : boite === "smtp" ? `ta boîte SMTP de l'ERP (${adresse})` : "l'envoi de l'ERP";
        if (propositions.length > avant && boite !== "gmail_adam") {
          const p = propositions[propositions.length - 1]!;
          p.proposition.title = brouillon ? `Brouillon dans ${dite}` : `Envoyer par ${dite}`;
          p.proposition.libelleBouton = brouillon ? "Enregistrer le brouillon" : "Envoyer";
          if (destinataireACompleter) p.proposition.warnings = [`Destinataire à compléter : « ${destinataireACompleter} » est introuvable dans l'annuaire — saisissez son adresse dans le champ « À » de la carte.`, ...(p.proposition.warnings ?? [])];
          if (piecesNonJointes.length) p.proposition.warnings = [...(p.proposition.warnings ?? []), `Pièce jointe non jointe : ${dite} n'envoie pas de fichier — ${piecesNonJointes.join(", ")} à transmettre depuis le Drive (lien de partage) ou par ta boîte Microsoft.`];
          if (formePerdue) p.proposition.warnings = [...(p.proposition.warnings ?? []), `Mise en forme non conservée : ${dite} n'envoie que du texte brut.`];
          if (rendu) p.proposition.mails = [rendu];
          await prisma.assistantActionIntent.update({ where: { id: p.intentId }, data: { title: p.proposition.title } }).catch(sansBloquer("mails.envoyer.titre-carte"));
        }
        let lu: Record<string, unknown> = {};
        try { lu = JSON.parse(sortie) as Record<string, unknown>; } catch { lu = { sortie }; }
        const repliAdam = boite === "erp" && !voulue && !!etat.gmailAdam && !etat.gmailAdam.envoi;
        // Des FAITS, plus de consigne (I1) : dans un tour, l'enveloppe remplace cette sortie par l'observation de la carte —
        // le repli et la pièce non jointe y sont, comme avertissements de la carte.
        if (repliAdam && propositions.length > avant) {
          const p = propositions[propositions.length - 1]!;
          p.proposition.warnings = [`La boîte Gmail d'Adam n'est pas reliée (${etat.gmailAdam?.raison ?? "aucune connexion Google"}) — elle se relie dans ${OU_RELIER_GMAIL_ADAM} ; ce mail part par l'envoi de l'ERP.`, ...(p.proposition.warnings ?? [])];
        }
        return json({ ...lu, boite: dite, ...(repliAdam ? { boite_adam: "non reliée" } : {}), ...(piecesNonJointes.length ? { pieces_non_jointes: piecesNonJointes } : {}), ...(destinataireACompleter ? { destinataire_a_completer: destinataireACompleter } : {}) });
      },
    },
  ];
}
