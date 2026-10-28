import { prisma } from "@/lib/prisma";
import { preparerAppelMission } from "@/platform/in-process/skills";
import type { CurrentUser } from "@/lib/session";
import { buildProposal, executeReadTool, performAction, RESOLVER_WRITE_NAMES } from "@/lib/assistant";
import { executeIntentGuarded, intentSummary } from "@/lib/assistant/action-intents";
import type { CapabilityCall, CapabilityOutcome, CapabilityRunner } from "@/lib/missions/ports";
import { estAutonome } from "@/lib/missions/registry/capability-meta";
import { journaliser } from "@/lib/missions/runtime/store";
import { ERROR_KINDS, type ErrorKind } from "@/lib/missions/recovery/strategy";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXÉCUTANT RÉEL — le seul point par lequel une mission touche l'ERP (§7 de la doctrine).
 *
 * ── LA RÈGLE, ET CE QU'ELLE INTERDIT ────────────────────────────────────────────────────
 *
 * Une mission passe par le MÊME chemin qu'un clic à l'écran. Pas un chemin parallèle « pour
 * l'automatisation », pas un raccourci « puisque c'est déjà validé ». Littéralement le même :
 *
 *   lecture  → `executeReadTool`, qui revérifie le droit à chaque appel ;
 *   écriture → `buildProposal` (le payload canonique) → `AssistantActionIntent` (l'état serveur)
 *              → `executeIntentGuarded` (la réclamation atomique) → `performAction` (RBAC,
 *              arrêt d'urgence, audit).
 *
 * C'est ce qui donne son sens à « une mission n'est jamais une porte dérobée ». Aucune règle de
 * sécurité n'a besoin d'être répétée ici : elles sont toutes DÉJÀ sur ce chemin, et c'est
 * précisément pour cela qu'on le reprend au lieu d'en écrire un plus court.
 *
 * ── L'IDEMPOTENCE, ET LE TROU QU'ELLE FERME ─────────────────────────────────────────────
 *
 * `executeIntentGuarded` protège d'un double-clic sur un intent EXISTANT. Elle ne protège pas
 * du cas propre aux missions : le processus meurt entre la création de l'intent et son
 * exécution, et la reprise ignore que le premier existe. La clé d'idempotence — unique EN BASE
 * — ferme ce trou : la reprise RETROUVE l'intent au lieu d'en créer un second.
 *
 * ── CE QUE LE RUNNER NE FAIT PAS ────────────────────────────────────────────────────────
 *
 * Il ne décide pas si une action est autorisée : `performAction` le fait. Il ne décide pas si
 * elle doit être approuvée : la porte d'approbation est un NŒUD du graphe, en amont. Il ne
 * réessaie pas : c'est le moteur qui compte les tentatives. Il exécute, et il rend un reçu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const estEcriture = (n: string): boolean => RESOLVER_WRITE_NAMES.has(n);

/**
 * UN TEXTE D'OUTIL RENDU EN OBJET QUAND C'EN EST UN — et le FAIT de savoir lequel des deux.
 *
 * ── POURQUOI `structure` VOYAGE AVEC LA VALEUR ─────────────────────────────────────────
 *
 * Une phrase nue emballée en `{ texte: … }` est INDISCERNABLE, en aval, d'un JSON qui portait
 * légitimement un champ `texte` — et c'est précisément le cas de `read_document`, qui rend
 * `{ nom, lien, texte }` quand il lit et une phrase quand il échoue. Le seul endroit du système
 * où la différence est encore visible est ICI, avant l'emballage.
 *
 * On la note donc au lieu de la perdre. `result-contract.ts` s'en sert pour refuser une phrase
 * là où un contrat promet une structure, SANS jamais lire la phrase : le contrôle porte sur la
 * forme, pas sur le sens — la même discipline que `empty-result.ts` applique à « aucun ».
 */
function structurer(brut: string): { valeur: unknown; structure: boolean } {
  const t = brut.trim();
  if (!t) return { valeur: { texte: "" }, structure: false };
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { valeur: JSON.parse(t), structure: true };
    } catch {
      // Une lecture qui commence par une accolade sans être du JSON est presque toujours un
      // message d'erreur formaté. On le garde en texte plutôt que de le perdre — et ce n'est
      // PAS une structure, quoi qu'en dise l'accolade.
      return { valeur: { texte: t }, structure: false };
    }
  }
  return { valeur: { texte: t }, structure: false };
}

/**
 * UN ÉCHEC QUE LA CAPACITÉ A ELLE-MÊME DÉCLARÉ (`capability-failure.ts`).
 *
 * C'est le chemin PRINCIPAL, et le seul qui nomme une cause exacte : l'outil sait s'il n'a pas
 * trouvé le fichier, s'il n'a pas su le lire, ou si le droit manquait. Une cause hors taxonomie
 * retombe sur `CAPABILITY_FAILURE` — on ne fait jamais passer un `echec` pour un succès sous
 * prétexte qu'on ne reconnaît pas son nom.
 */
function echecDeclare(v: unknown): { kind: ErrorKind; message: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.echec !== "string" || o.echec.trim() === "") return null;
  const kind = (ERROR_KINDS as readonly string[]).includes(o.echec)
    ? (o.echec as ErrorKind)
    : "CAPABILITY_FAILURE";
  const message = typeof o.message === "string" && o.message.trim() !== "" ? o.message : o.echec;
  return { kind, message };
}

/**
 * LES RÉPONSES QUI SONT DES REFUS — la CEINTURE, pas la bretelle.
 *
 * `executeReadTool` rend une PHRASE quand le droit manque ou que la lecture échoue — c'est le
 * bon comportement en conversation, où un humain lit la phrase. Dans une mission, une phrase
 * d'excuse rangée comme un résultat serait ensuite comptée comme une étape réussie, et le
 * contrôle qualité la validerait. On la reconnaît donc et on ÉCHOUE l'étape.
 *
 * Ces trois motifs restent, mais ils ne sont plus la défense principale : une reconnaissance de
 * phrase ne peut couvrir que les tournures qu'on a pensé à écrire, et un run réel a montré
 * qu'elle en manquait six sur sept pour la seule `read_document`. Ce qui garde maintenant, c'est
 * l'échec DÉCLARÉ ci-dessus et le contrat de résultat en aval. Celles-ci attrapent le reliquat
 * des capacités que personne n'a encore converties.
 */
const REFUS = [
  /ne vous est pas ouvert/i,
  /^la lecture a échoué/i,
  /je préfère ne rien avancer/i,
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * LES ÉCHECS DURABLES D'UNE LECTURE — classés, jamais devinés.
 *
 * Un `fetch` qui casse est transitoire : on retente, et c'est le bon réflexe. Un stockage qui
 * répond 402 (paiement exigé), 401/403 (clé refusée) ou 404 (l'objet n'existe pas) ne change
 * pas d'avis à la troisième tentative — et le Deep Smoke a MESURÉ ce que coûte de l'ignorer :
 * le même blob relu à chaque tentative, chaque replan, chaque mission, contre un quota épuisé.
 *
 * Le classement est VOLONTAIREMENT étroit : seuls les motifs dont on est SÛR (le message
 * exact de `object-storage.ts`, ou un vocabulaire de facturation sans ambiguïté) sont déclarés
 * durables. Tout le reste garde `retryable: true` — dans le doute, on retente (le contraire
 * du décodeur : ici, rater un durable coûte trois tentatives ; déclarer durable un transitoire
 * coûterait une réponse fausse).
 */
export function classerEchecLecture(message: string): { kind: ErrorKind; action: string } | null {
  // Le message EXACT de `s3Failure` : « Lecture de l'objet échouée (NNN) sur /… ».
  const objet = message.match(/de l['’]objet échouée \((\d{3})/i);
  const statut = objet ? Number(objet[1]) : null;
  if (statut === 402 || /payment required|quota exceeded|billing|insufficient (?:credit|funds)/i.test(message)) {
    return {
      kind: "PROVIDER_FAILURE",
      action: "— refus de FACTURATION/QUOTA du fournisseur de stockage : réessayer ne sert à rien, une action humaine (facturation) est requise.",
    };
  }
  if (statut === 401 || statut === 403) {
    return {
      kind: "PROVIDER_FAILURE",
      action: "— identifiants de stockage refusés : réessayer ne sert à rien, la configuration doit être corrigée.",
    };
  }
  if (statut === 404) {
    return {
      kind: "MISSING_DOCUMENT",
      action: "— l'objet n'existe pas à cette adresse : le document est absent du stockage, pas temporairement illisible.",
    };
  }
  return null;
}

const TTL_ECHEC_DURABLE_MS = 10 * 60 * 1000;
const PLAFOND_ECHECS_DURABLES = 300;
const ECHECS_DURABLES = new Map<string, { kind: ErrorKind; message: string; at: number }>();

function retenirEchecDurable(cle: string, kind: ErrorKind, message: string): void {
  ECHECS_DURABLES.set(cle, { kind, message, at: Date.now() });
  if (ECHECS_DURABLES.size > PLAFOND_ECHECS_DURABLES) {
    const premier = ECHECS_DURABLES.keys().next().value;
    if (premier !== undefined) ECHECS_DURABLES.delete(premier);
  }
}

/** Pour les bancs : repartir d'une table vierge. Jamais appelé en production. */
export function __videEchecsDurables(): void { ECHECS_DURABLES.clear(); }

export class ExecutantReel implements CapabilityRunner {
  constructor(private readonly user: CurrentUser) {}

  async run(call: CapabilityCall): Promise<CapabilityOutcome> {
    if (call.actor.userId !== this.user.id) {
      // UN EXÉCUTANT NE SERT QU'UNE PERSONNE. Un acteur qui ne correspond pas signale un
      // composeur réutilisé à tort — et l'exécuter emprunterait les droits de quelqu'un d'autre.
      return {
        ok: false,
        output: null,
        error: { kind: "MISSING_PERMISSION", message: "l'exécutant n'appartient pas à cet acteur", retryable: false },
      };
    }

    // LA QUESTION « CETTE CAPACITÉ LAISSE-T-ELLE UNE TRACE ? » A UNE SEULE RÉPONSE, et elle
    // vit avec le barème d'effets qu'elle interroge. La recopier ici en comparant les rangs à la
    // main marcherait aujourd'hui et divergerait le jour où un niveau s'insère au milieu — c'est
    // le genre d'écart qui envoie une écriture sur le chemin de lecture, donc sans intent, sans
    // approbation et sans reçu.
    // LE CHEMIN EST CELUI DE LA CONVERSATION : ce que la liste d'écritures nomme part par les
    // intents (proposition, accord, reçu) ; tout le reste part par `executeReadTool` — y compris
    // les écritures AUTONOMES (rappels, souvenirs, exports), que le chemin des intents ne connaît
    // pas. Leur effet, lui, reste une écriture : approbation demandée, jamais groupées, et gardées
    // ci-dessous par une clé d'idempotence pour ne pas être rejouées après une panne.
    // UN SKILL QUI ÉCRIT OU ENGAGE (§36) exige `confirmer: true` : dans une mission, cet accord a été donné
    // par la porte d'approbation — le RUNNER le pose, jamais le modèle.
    const appel = { ...call, input: preparerAppelMission(this.user.id, call.capability, call.input) };
    return estEcriture(appel.capability) ? this.ecrire(appel) : this.lire(appel);
  }
  /**
   * LA GARDE DES ÉCRITURES AUTONOMES — « ce rappel a-t-il déjà été posé par cette étape ? »
   *
   * Le chemin des lectures n'a ni intent ni reçu. Une étape `plan_reminder` reprise après une
   * panne entre l'effet et l'écriture de son état reposerait le rappel. La clé d'idempotence de
   * l'étape (persistée AVANT l'effet par le moteur) est inscrite au journal canonique de la
   * mission avec la sortie ; la relire coûte une requête et rend l'effet unique. Le journal est
   * le seul registre (§17) — pas de table de plus.
   */
  private async dejaProduit(call: CapabilityCall): Promise<CapabilityOutcome | null> {
    if (!call.idempotencyKey || !call.missionId) return null;
    const marque = await prisma.missionEvent.findFirst({
      where: { missionId: call.missionId, kind: "AUTONOMOUS_EFFECT", detail: { path: ["idempotencyKey"], equals: call.idempotencyKey } },
      select: { detail: true },
    }).catch(sansBloquer("missions-runner.dejaProduit.missionEvent", null));
    if (!marque) return null;
    const d = (marque.detail ?? {}) as { output?: unknown };
    return { ok: true, deduplicated: true, output: d.output ?? { rejoue: true } };
  }
  private async marquerProduit(call: CapabilityCall, output: unknown): Promise<void> {
    if (!call.idempotencyKey || !call.missionId) return;
    const texte = typeof output === "string" ? output.slice(0, 2_000) : output;
    await journaliser(call.missionId, "AUTONOMOUS_EFFECT",
      `Écriture autonome « ${call.capability} » produite (étape ${call.stepKey}).`,
      { stepKey: call.stepKey, capability: call.capability, idempotencyKey: call.idempotencyKey, output: texte as never }).catch(sansBloquer("missions-runner.marquerProduit.journaliser"));
  }

  // ── LECTURE ────────────────────────────────────────────────────────────────────────
  private async lire(call: CapabilityCall): Promise<CapabilityOutcome> {
    // ── LE COURT-CIRCUIT — un refus DURABLE déjà constaté ne se re-paye pas ─────────────
    //
    // Le Deep Smoke du 2026-08-29 a montré le même blob relu en boucle contre un stockage qui
    // répondait 402 (paiement/quota) : chaque étape payait ses tentatives, chaque replan
    // relisait le même objet, et le raisonnement « réparait » une panne de FACTURATION.
    // Un refus durable constaté une fois vaut pour les minutes qui suivent — et le reçu LE DIT.
    const cle = `${call.capability}|${JSON.stringify(call.input ?? {})}`.slice(0, 500);
    const constate = ECHECS_DURABLES.get(cle);
    if (constate && Date.now() - constate.at < TTL_ECHEC_DURABLE_MS) {
      return {
        ok: false,
        output: null,
        error: {
          kind: constate.kind,
          message: `COURT-CIRCUIT — échec durable déjà constaté il y a ${Math.round((Date.now() - constate.at) / 1000)}s, non re-tenté : ${constate.message}`,
          retryable: false,
        },
      };
    }

    // ── L'ÉCRITURE AUTONOME DÉJÀ FAITE REND SA SORTIE, SANS RIEN REFAIRE ────────────────
    const autonome = estAutonome(call.capability);
    if (autonome) {
      const deja = await this.dejaProduit(call);
      if (deja) return deja;
    }
    let brut: string;
    try {
      brut = await executeReadTool(call.capability, call.input, this.user);
    } catch (e) {
      const message = e instanceof Error ? e.message : "la lecture a échoué";
      const durable = classerEchecLecture(message);
      if (durable) {
        retenirEchecDurable(cle, durable.kind, message);
        return { ok: false, output: null, error: { kind: durable.kind, message: `${message} ${durable.action}`, retryable: false } };
      }
      return {
        ok: false,
        output: null,
        error: {
          kind: "CAPABILITY_FAILURE",
          message,
          retryable: true,
        },
      };
    }

    if (REFUS.some((r) => r.test(brut))) {
      // La phrase de refus porte désormais sa CAUSE TECHNIQUE (executePowerTool la préserve) :
      // un 402/quota enveloppé dans « la lecture a échoué » se classe donc DURABLE ici aussi —
      // sans quoi le run Render l'a montré : trois tentatives, recours, replans, contre une
      // panne de facturation dont le motif avait été avalé en route.
      const durable = classerEchecLecture(brut);
      if (durable) retenirEchecDurable(cle, durable.kind, brut);
      return {
        ok: false,
        output: null,
        error: {
          kind: durable?.kind ?? (brut.match(/ne vous est pas ouvert/i) ? "MISSING_PERMISSION" : "CAPABILITY_FAILURE"),
          message: `${brut.slice(0, 300)}${durable ? ` ${durable.action}` : ""}`,
          retryable: durable ? false : !brut.match(/ne vous est pas ouvert/i),
        },
      };
    }

    const { valeur, structure } = structurer(brut);

    // L'ÉCHEC QUE LA CAPACITÉ A DIT ELLE-MÊME. Il précède tout le reste : personne d'autre ne
    // connaît la cause exacte, et la deviner en aval serait la fabriquer.
    const declare = echecDeclare(valeur);
    if (declare) {
      return {
        ok: false,
        output: valeur,
        structured: structure,
        error: {
          kind: declare.kind,
          message: declare.message.slice(0, 300),
          // UN DROIT MANQUANT NE REVIENT PAS EN RÉESSAYANT. Le reste peut être transitoire, et
          // l'échelle de recours saura de toute façon quoi en faire — rejouer n'est que son
          // premier barreau.
          retryable: declare.kind !== "MISSING_PERMISSION",
        },
      };
    }

    // ── UNE ÉCRITURE AUTONOME QUI RÉPOND PAR UNE PHRASE N'A RIEN ÉCRIT ─────────────────
    //
    // Ces capacités rendent un OBJET quand elles ont agi (« ok », identifiant, échéance) et une
    // PHRASE quand elles refusent — « Date illisible », « Personne introuvable », « Précisez ».
    // La conversation lit la phrase ; une mission la rangeait comme un résultat, marquait
    // l'étape DONE et comptait un rappel qui n'existait pas. Le contrat est donc structurel :
    // pas d'objet, pas d'effet — l'étape échoue, l'échelle de recours décide, et la garde
    // d'idempotence n'inscrit rien qu'une reprise pourrait croire déjà fait.
    if (autonome && !structure) {
      const message = messageDeRefus(valeur);
      return {
        ok: false,
        output: valeur,
        error: { kind: "INCOMPATIBLE_RESULT", message: `${call.capability} n'a rien écrit : ${message}`, retryable: false },
      };
    }
    if (autonome) await this.marquerProduit(call, valeur);
    return { ok: true, output: valeur, structured: structure };
  }

  // ── ÉCRITURE ───────────────────────────────────────────────────────────────────────
  private async ecrire(call: CapabilityCall): Promise<CapabilityOutcome> {
    const cle = call.idempotencyKey;

    // 1. UN INTENT DÉJÀ EXÉCUTÉ REND SON REÇU, SANS RIEN RELANCER.
    if (cle) {
      const deja = await prisma.assistantActionIntent.findUnique({
        where: { idempotencyKey: cle },
        select: { id: true, status: true, resultMessage: true, resultLink: true },
      });
      if (deja?.status === "EXECUTED") {
        return {
          ok: true,
          deduplicated: true,
          output: { receipt: deja.id, message: deja.resultMessage, link: deja.resultLink, rejoue: true },
        };
      }
      if (deja) return this.executerIntent(deja.id);
    }

    // 2. LE PAYLOAD CANONIQUE — celui-là même que produit la conversation.
    const proposition = await buildProposal(call.capability, call.input, this.user);
    if ("error" in proposition) {
      return {
        ok: false,
        output: null,
        error: { kind: "INVALID_STEP", message: proposition.error, retryable: false },
      };
    }
    if (proposition.warnings.length > 0 && proposition.fields.length === 0) {
      // Une proposition sans aucun champ résolu ET avec des avertissements est une cible
      // introuvable : agir dessus enverrait dans le vide. C'est un CIBLE_INTROUVABLE, pas une
      // panne — la récupération sait quoi en faire (chercher ailleurs, demander).
      return {
        ok: false,
        output: null,
        error: { kind: "TARGET_NOT_FOUND", message: proposition.warnings.join(" ; "), retryable: false },
      };
    }

    // 3. L'INTENT — l'état serveur canonique, porteur de la clé et du reçu.
    let intentId: string;
    try {
      const cree = await prisma.assistantActionIntent.create({
        data: {
          userId: this.user.id,
          kind: proposition.kind,
          module: proposition.module,
          title: proposition.title,
          summary: intentSummary(proposition),
          payload: proposition.payload as never,
          status: "CONFIRMED",
          origin: "text",
          level: proposition.level ?? null,
          confirmText: proposition.confirmText ?? null,
          idempotencyKey: cle,
          missionId: call.missionId,
          events: [{ status: "PROPOSED", at: new Date().toISOString() }] as never,
        },
        select: { id: true },
      });
      intentId = cree.id;
    } catch {
      // LA COURSE : deux exécutions concurrentes de la même étape. La contrainte d'unicité a
      // désigné un gagnant ; le perdant reprend l'intent du gagnant au lieu d'en créer un
      // second. C'est exactement le comportement voulu, et il est garanti par la base.
      const gagnant = cle
        ? await prisma.assistantActionIntent.findUnique({ where: { idempotencyKey: cle }, select: { id: true } })
        : null;
      if (!gagnant) {
        return {
          ok: false,
          output: null,
          error: { kind: "CAPABILITY_FAILURE", message: "l'action n'a pas pu être enregistrée", retryable: true },
        };
      }
      intentId = gagnant.id;
    }

    return this.executerIntent(intentId);
  }

  /**
   * EXÉCUTE SOUS L'INTENT — réclamation atomique, RBAC revérifié, reçu persisté.
   *
   * `performAction` est le MÊME appel que celui de la carte de confirmation à l'écran.
   */
  private async executerIntent(intentId: string): Promise<CapabilityOutcome> {
    const garde = await executeIntentGuarded(this.user, intentId, async (stored) =>
      performAction(this.user, stored as Parameters<typeof performAction>[1]));

    if (!garde) {
      return {
        ok: false,
        output: null,
        error: { kind: "CAPABILITY_FAILURE", message: "l'intent d'action est introuvable", retryable: false },
      };
    }
    if (!garde.ok) {
      return {
        ok: false,
        output: null,
        error: {
          kind: "CAPABILITY_FAILURE",
          message: garde.error ?? "l'action a échoué",
          // Un échec d'exécution est rejouable : la clé garantit qu'un rejeu ne double pas
          // l'effet, et la plupart de ces échecs sont transitoires.
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      deduplicated: garde.alreadyExecuted === true,
      output: { receipt: intentId, message: garde.message, link: garde.link },
    };
  }
}

/**
 * CE QU'UNE ÉCRITURE AUTONOME A DIT EN REFUSANT — pour que l'échelle de recours et la
 * replanification lisent la cause (« Donnez la cible à surveiller ») plutôt que « réponse non
 * structurée », qui ne dit rien à personne. Le chemin des lectures emballe parfois la phrase
 * dans un objet (`{ texte }`) : on la ressort ; sinon, un extrait brut.
 */
function messageDeRefus(valeur: unknown): string {
  if (typeof valeur === "string") return valeur.slice(0, 300);
  if (valeur && typeof valeur === "object" && !Array.isArray(valeur)) {
    const o = valeur as Record<string, unknown>;
    for (const k of ["texte", "message", "error", "erreur", "raison", "text"]) {
      if (typeof o[k] === "string" && (o[k] as string).trim() !== "") return (o[k] as string).slice(0, 300);
    }
  }
  let brut = "";
  try { brut = JSON.stringify(valeur) ?? ""; } catch { brut = String(valeur); }
  return `réponse non structurée (${brut.slice(0, 160)})`;
}
