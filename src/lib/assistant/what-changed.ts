import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { resolveRecord } from "@/lib/assistant/time-travel";
import { REGULATORY_STEP_TYPE } from "@/lib/labels";
import { startChangeFeed, recentChanges, feedHealth } from "./platform/change-feed";
import { faitsRecents } from "@/lib/events/ledger";
import { canAccessEntity } from "@/lib/entity-access";
import { sansBloquer } from "@/lib/journal";

/**
 * WHAT CHANGED / CATCH ME UP — « qu'est-ce qui a changé sur Pembro depuis lundi ? »,
 * « remets-moi à niveau sur ce dossier ».
 *
 * Le diff se lit dans les données TRACÉES : journal d'audit depuis la date de référence,
 * étapes réglementaires franchies, validations rendues — puis l'ÉTAT ACTUEL en face (ce que
 * l'exécutif veut : ce qui a bougé, où on en est, qui a agi). Seuls les changements
 * SIGNIFICATIFS remontent (un mouvement sans résumé ni champ tracé est du bruit technique).
 * Rien n'est inventé : « aucun changement tracé » est une réponse honnête et complète.
 */

type EntityTypeLike = Parameters<typeof canAccessEntity>[1] | null;

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

function fr(d: Date): string {
  const alg = new Date(d.getTime() + 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(alg.getUTCDate())}/${p(alg.getUTCMonth() + 1)}/${alg.getUTCFullYear()} ${p(alg.getUTCHours())}:${p(alg.getUTCMinutes())}`;
}

/** La date de référence : AAAA-MM-JJ (début de journée Alger) ou « il y a N jours ». */
export function parseSince(raw: string, now = new Date()): Date | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00+01:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const days = Number.parseInt(s, 10);
  if (Number.isFinite(days) && days > 0 && days <= 365 && /^\d{1,3}$/.test(s)) {
    return new Date(now.getTime() - days * 86_400_000);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SEULE FORME, QUOI QU'IL ARRIVE (§118.20) — c'est la VALEUR qui dit l'absence.
 *
 * Cet outil rendait SIX formes selon ce qu'il trouvait, dont trois qui n'étaient même pas du
 * JSON : le flux éteint rendait une phrase, la date illisible une phrase, le dossier inconnu une
 * phrase ; le flux vide rendait `{changements: 0, precision}` et le flux plein
 * `{changements, depuis, portee, faits, suite}` — où `changements` était un NOMBRE ici et un
 * OBJET `{total, significatifs}` là. Le planificateur écrit ses références AVANT de savoir ce
 * que la lecture rendra : il ne pouvait pas gagner. Une référence sur `faits` mourait le jour
 * où le flux était vide, une référence sur `changements.significatifs` le jour où il ne l'était
 * pas — et une étape morte coûte une replanification entière.
 *
 * Les clés sont donc TOUJOURS les mêmes, et c'est la valeur qui parle : une liste VIDE pour
 * « rien trouvé » (le moteur sait déjà l'ignorer : « si la liste amont est vide, l'étape est
 * ignorée »), `null` pour un scalaire absent, et une `precision` qui dit toujours ce que la
 * réponse couvre ET ce qu'elle ne couvre pas. Un « rien n'a changé » qui signifierait en
 * réalité « je viens de démarrer » serait un mensonge tranquille, du genre qui fait rater une
 * validation urgente.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
interface ReponseChangements {
  portee: "flux" | "dossier";
  type: string | null;
  reference: string | null;
  titre: string | null;
  depuis: string | null;
  changements: Record<string, unknown>[];
  etapesFranchies: Record<string, unknown>[];
  quiAAgi: { nom: string; actions: number }[];
  /** L'état du dossier, tel que la fiche le publie. `null` sur le flux — jamais absent. */
  etatActuel: Record<string, unknown> | null;
  lien: string | null;
  /** Renseigné quand la lecture a buté sur sa borne — sinon `null`, jamais absent. */
  borne: string | null;
  /** Ce que la réponse couvre ET ce qu'elle ne couvre pas. Toujours une phrase. */
  precision: string;
}

const VIDE: Omit<ReponseChangements, "portee" | "precision"> = {
  type: null, reference: null, titre: null, depuis: null,
  changements: [], etapesFranchies: [], quiAAgi: [], etatActuel: null, lien: null, borne: null,
};

const repondre = (r: Partial<ReponseChangements> & Pick<ReponseChangements, "portee" | "precision">): string =>
  JSON.stringify({ ...VIDE, ...r });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUOI DE NEUF ? » SANS RÉFÉRENCE — DEUX sources, et il en fallait deux.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Cette réponse n'avait qu'UNE source : la projection en mémoire du processus. Elle est honnête
 * sur elle-même — elle ne voit que ce qui s'est passé depuis le démarrage de CE serveur — mais
 * c'était la seule, donc l'outil répondait « le flux n'est pas actif : je ne peux pas dire ce
 * qui a bougé à l'instant » ou « aucun changement depuis le démarrage de ce serveur ». Or Render
 * redémarre le processus à CHAQUE déploiement, et `BusinessEvent` — le registre canonique — porte
 * pendant ce temps toute l'activité. Un « je ne peux pas » écrit dans le CODE (§118.63, §118.93).
 *
 * ── POURQUOI ON NE REMPLACE PAS, ON FUSIONNE ────────────────────────────────────────────
 *
 * Mesuré, et c'est ce qui interdisait le raccourci : les deux sources ne portent PAS les mêmes
 * faits. Le bus en mémoire est alimenté par `emit` depuis trois fichiers (RH, Regulatory, envois
 * sortants) ; le registre durable par `recordBusinessEvent` depuis neuf domaines (LEGAL,
 * FINANCES, VALIDATIONS, PCH, SALES, REGULATORY, LOGISTICS, ADPRO_CONSULTING, DRIVE). Ne garder
 * que le registre perdrait les faits du bus ; ne garder que le bus perd tout après un
 * redéploiement. Chacun apporte ce que l'autre n'a pas.
 *
 * ── L'AUTORITÉ DE CHAQUE FAIT VOYAGE AVEC LUI ───────────────────────────────────────────
 *
 * `source: "registre"` fait foi (durable, inter-processus) ; `source: "flux"` est un INDICE, et
 * `change-feed.ts` le dit en toutes lettres. Les mélanger sans le dire ferait passer un indice
 * partiel pour une vérité — exactement ce que ce fichier interdit.
 *
 * ── LE CLOISONNEMENT EST PAR ENREGISTREMENT, PAS PAR DOMAINE ────────────────────────────
 *
 * `canAccessEntity` répond par ligne. Filtrer par domaine montrerait le dossier confidentiel
 * d'un service ouvert (§118.71 : une porte gardée à côté d'une porte ouverte). L'outil est
 * aujourd'hui réservé à la direction, dont l'accès est global — la garde ne coûte donc rien
 * ici, et elle est juste le jour où cette réserve tombe : une garde qui dépend du filtre de son
 * appelant est une garde qu'un futur appelant contournera sans le savoir.
 *
 * Ce qui n'a pas pu être cloisonné à coup sûr est ÉCARTÉ et COMPTÉ (§118.52) : un filtre
 * silencieux ne laisse aucune trace de ce qu'il retire, et un dirigeant qui lit « 3 faits »
 * sur douze doit savoir qu'il en manque neuf.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function liveFeedAnswer(user: CurrentUser, depuis: Date | null): Promise<string> {
  const since = depuis ?? new Date(Date.now() - 7 * 86_400_000);
  startChangeFeed();
  const health = feedHealth();

  const durables = await faitsRecents({ since, limit: 60 }).catch(sansBloquer("what-changed.liveFeedAnswer.faitsRecents", null));
  const montres = durables?.faits.length ?? 0;
  const enMemoire = recentChanges({ limit: 30 });

  type Brut = { quoi: string; sujet: string; libelle: string | null; quand: string; source: "registre" | "flux"; type: EntityTypeLike; id: string | null };
  const bruts: Brut[] = [
    ...(durables?.faits ?? []).map((f) => ({
      quoi: f.type,
      sujet: f.entityType && f.entityId ? `${f.entityType}/${f.entityId}` : f.sourceDomain,
      libelle: null,
      quand: f.occurredAt.toISOString(),
      source: "registre" as const,
      type: f.entityType,
      id: f.entityId,
    })),
    ...enMemoire
      .filter((c) => c.at >= since.toISOString())
      .map((c) => ({
        quoi: c.type,
        sujet: `${c.subjectType}/${c.subjectId}`,
        libelle: c.label,
        quand: c.at,
        source: "flux" as const,
        // Le sujet du bus n'est pas typé `EntityType` : on ne prétend pas le cloisonner par
        // enregistrement, on l'écarte si l'on ne sait pas le lire (voir plus bas).
        type: null as EntityTypeLike,
        id: c.subjectId,
      })),
  ];

  // UN MÊME FAIT VU DEUX FOIS N'EST PAS DEUX FAITS. La clé est le fait lui-même — son type, son
  // sujet, son instant — et le registre gagne, parce qu'il fait foi.
  const vus = new Map<string, Brut>();
  for (const b of bruts) {
    const cle = `${b.quoi}|${b.sujet}|${b.quand}`;
    const dejala = vus.get(cle);
    if (!dejala || (dejala.source === "flux" && b.source === "registre")) vus.set(cle, b);
  }

  let ecartes = 0;
  const lisibles: Brut[] = [];
  for (const b of [...vus.values()].sort((x, y) => (x.quand < y.quand ? 1 : -1))) {
    if (!b.type || !b.id) { ecartes += 1; continue; }
    if (!(await canAccessEntity(user, b.type, b.id, "VIEW"))) { ecartes += 1; continue; }
    lisibles.push(b);
  }

  // UNE COUPE SILENCIEUSE SE LIT COMME UNE EXHAUSTIVITÉ (§118.60). Mesuré sur la base de
  // travail : 26 332 faits sur sept jours. « Voici ce qui a bougé » sur les soixante plus
  // récents ferait lire les dernières minutes comme le bilan de la semaine.
  const tronque = durables !== null && durables.total > montres;
  const bornes = [
    ecartes > 0 ? `${ecartes} fait(s) écarté(s) : hors de votre périmètre ou sans enregistrement lisible` : null,
    tronque ? `${durables!.total} faits dans la fenêtre, les ${montres} plus récents seulement sont lus — resserrer « since » pour voir une période plus courte en entier` : null,
  ].filter(Boolean);

  const couverture = durables === null
    ? "Le registre canonique n'a pas pu être lu (erreur de base) : cette liste ne porte que ce que ce serveur a vu depuis son démarrage. "
      + "Une liste courte ne prouve donc RIEN sur l'activité réelle."
    : `${durables.total} fait(s) au registre canonique depuis le ${fr(since)}${health.started ? ", complétés par ce que ce serveur a vu depuis son démarrage" : ""}. `
      + "« registre » fait foi ; « flux » est un indice de ce processus, pas un journal exhaustif.";

  /**
   * LE REGISTRE EST PARTIEL PAR CONSTRUCTION — et c'est à LUI de le dire.
   *
   * Mesuré sur le banc, question « Résume-moi la semaine » : le registre porte 8 faits sur la
   * fenêtre, dont 5 sans enregistrement lisible ; au même instant l'ERP comptait 35 objets
   * modifiés. `BusinessEvent` ne contient que ce que les domaines ÉMETTENT, et un fait sans
   * `entityType`/`entityId` n'est pas rendu (on cloisonne par ENREGISTREMENT, jamais par
   * domaine — §118.104). Une réponse de trois lignes bâtie là-dessus est donc CHEAP, ASSURÉE,
   * et pauvre : le faux succès exact que ce dépôt ferme partout ailleurs.
   *
   * On ne desserre PAS le cloisonnement pour étoffer la réponse — ce serait échanger une
   * pauvreté contre une fuite. On NOMME le geste qui complète (§118.19, §118.30), et seulement
   * quand le fait est là : peu de faits rendus, ou des faits écartés. Se taire laisserait
   * conclure « rien n'a bougé cette semaine » ; le dire toujours ferait du bruit qu'on cesse de
   * lire (§118.32).
   *
   * LE SEUIL PORTE SA RAISON, sinon c'est une constante sans justification (§118.116). Douze,
   * c'est moins de deux faits par jour sur la fenêtre par défaut : en dessous, le registre ne
   * peut PAS raconter une semaine d'entreprise, quelle que soit la cause. Au-dessus, il faut
   * encore qu'aucun fait n'ait été écarté — et sur une semaine chargée cette seconde condition
   * sera souvent vraie, parce que TOUT fait du flux en mémoire est écarté (il n'est pas typé,
   * donc pas cloisonnable par enregistrement). Ce n'est pas du bruit : c'est une propriété
   * permanente de la source, et la taire ferait conclure à une complétude qui n'existe pas.
   * La phrase ne se tait que sur le cas qui la mérite — beaucoup de faits rendus, aucun écarté.
   */
  const ETOFFER_SOUS = 12;
  const partiel = durables !== null && (lisibles.length < ETOFFER_SOUS || ecartes > 0);
  const completer = partiel
    ? " CE REGISTRE NE PORTE QUE LES FAITS ÉMIS, et seuls ceux rattachés à un enregistrement lisible sont rendus : "
      + "il ne dit donc PAS l'état des dossiers, contrats et budgets. Pour un résumé de période qu'un dirigeant peut utiliser, "
      + "compléter par regulatory_intelligence, legal_intelligence, finance_intelligence et list_pending_decisions — "
      + "une liste courte ici n'est pas la preuve que la semaine a été calme."
    : "";

  return repondre({
    portee: "flux",
    depuis: since.toISOString(),
    changements: lisibles.map((b) => ({ quoi: b.quoi, sujet: b.sujet, libelle: b.libelle, quand: b.quand, source: b.source })),
    borne: bornes.length > 0 ? bornes.join(" ; ") : null,
    precision: lisibles.length === 0
      ? `Aucun fait lisible depuis le ${fr(since)}. ${couverture}${completer} Pour un dossier précis, donner sa référence.`
      : `${couverture}${completer} Pour le détail d'un de ces sujets, appeler inspect_record ou what_changed avec sa référence.`,
  });
}

export const WHAT_CHANGED_TOOLS: PowerTool[] = [
  {
    def: {
      name: "what_changed",
      description:
        "CE QUI A CHANGÉ sur un dossier depuis une date — « qu'est-ce qui a changé sur Pembro depuis lundi ? », " +
        "« remets-moi à niveau », « qu'est-ce qui s'est passé depuis notre dernière discussion ? » (donner la date de cette " +
        "discussion). Renvoie : les CHANGEMENTS SIGNIFICATIFS tracés depuis la date (qui a fait quoi, champ avant → après), " +
        "les étapes réglementaires franchies (dossier Regulatory), QUI a agi sur la période, et l'ÉTAT ACTUEL en face. " +
        "Couvre demandes de paiement, règlements, documents Legal, dossiers Regulatory, tâches. Lecture seule ; " +
        "« aucun changement tracé » est une réponse honnête, pas un échec. " +
        "SANS référence : « quoi de neuf ? » — les faits du REGISTRE CANONIQUE sur la fenêtre (durables, tous serveurs confondus), " +
        "complétés par ce que ce serveur a vu depuis son démarrage. Chaque fait porte sa source : « registre » fait foi, « flux » est un indice.",
      input_schema: {
        type: "object",
        properties: {
          reference: { type: "string", description: "Référence (PAY-…, REG-…) ou fragment de titre du dossier. OMETTRE pour « quoi de neuf dans l'entreprise, à l'instant ? »." },
          since: { type: "string", description: "La date de référence : AAAA-MM-JJ, ou un nombre de jours en arrière (ex. « 7 »). SANS référence, elle borne la fenêtre du « quoi de neuf » (défaut : 7 jours) — la resserrer (« 1 ») quand la réponse dit qu\u2019elle a été tronquée." },
        },
        required: [],
      },
    },
    allowed: EXEC,
    label: "Changements depuis la date",
    run: async (input, user) => {
      const ref = str(input, "reference");
      const rawSince = str(input, "since");

      // SANS RÉFÉRENCE : « quoi de neuf tout court ? ». Cette question-là n'avait aucune réponse
      // rapide — il fallait balayer une dizaine de tables et comparer des horodatages. Le flux
      // d'événements y répond en mémoire, sans base ni réseau.
      if (ref.length < 2) return liveFeedAnswer(user, parseSince(rawSince));
      const since = parseSince(rawSince);
      // Un refus garde la MÊME forme que la réponse : le planificateur a écrit ses références
      // avant de savoir si la date serait lisible, et une forme différente les tue toutes.
      if (!since) {
        return repondre({
          portee: "dossier", reference: ref,
          precision: `Date de référence illisible : « ${rawSince} ». La liste est vide parce que la QUESTION n'a pas pu être posée, `
            + "pas parce que rien n'a changé. Donner AAAA-MM-JJ ou un nombre de jours (ex. « 7 »).",
        });
      }

      const record = await resolveRecord(ref);
      if (!record) {
        return repondre({
          portee: "dossier", reference: ref, depuis: fr(since),
          precision: `Aucun dossier ne porte « ${ref} » — ni demande de paiement, ni règlement, ni document Legal, ni dossier `
            + "Regulatory, ni tâche. La liste est vide parce que le SUJET est introuvable, pas parce que rien n'a changé. "
            + "Vérifier la référence (search_everything).",
        });
      }

      // Le journal DEPUIS la date + les étapes réglementaires franchies — en parallèle.
      const [audits, stepsDone] = await Promise.all([
        prisma.auditLog.findMany({
          where: { entityType: record.entityType as never, entityId: record.id, createdAt: { gt: since } },
          select: { createdAt: true, action: true, summary: true, field: true, oldValue: true, newValue: true, actor: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
          take: 120,
        }),
        record.entityType === "REGULATORY_PRODUCT"
          ? prisma.regulatoryStep.findMany({
              where: { productId: record.id, actualDate: { gt: since } },
              select: { type: true, actualDate: true, responsible: true },
              orderBy: { actualDate: "asc" },
            })
          : Promise.resolve([]),
      ]);

      // ÉVÉNEMENT SIGNIFICATIF vs bruit technique : un résumé lisible ou un champ tracé.
      const meaningful = audits.filter((a) => Boolean(a.summary) || Boolean(a.field));

      // QUI a agi sur la période — l'ébauche de « qui a travaillé dessus ».
      const byActor = new Map<string, number>();
      for (const a of meaningful) {
        const name = a.actor?.name ?? "système";
        byActor.set(name, (byActor.get(name) ?? 0) + 1);
      }
      const acteurs = [...byActor.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([nom, actions]) => ({ nom, actions }));

      const changements = meaningful.slice(-25).map((a) => ({
        le: fr(a.createdAt),
        quoi: a.summary ?? a.action,
        ...(a.field ? { champ: a.field, de: a.oldValue, a: a.newValue } : {}),
        ...(a.actor?.name ? { par: a.actor.name } : {}),
      }));

      const etapesFranchies = stepsDone.map((s) => ({
        etape: REGULATORY_STEP_TYPE[s.type] ?? s.type,
        faiteLe: s.actualDate ? fr(s.actualDate) : null,
        ...(s.responsible ? { par: s.responsible } : {}),
      }));

      const rien = meaningful.length === 0 && etapesFranchies.length === 0;
      return repondre({
        portee: "dossier",
        type: record.type, reference: record.reference, titre: record.titre,
        depuis: fr(since),
        changements, etapesFranchies, quiAAgi: acteurs,
        etatActuel: record.etatActuel,
        lien: record.lien,
        borne: audits.length >= 120 ? "journal borné à 120 mouvements : les plus anciens de la période ne sont pas listés" : null,
        precision: rien
          ? "Aucun changement SIGNIFICATIF tracé sur ce dossier depuis cette date — ni au journal, ni sur les étapes. "
            + "Le journal ne capture que ce qui a été tracé dans l'ERP : un échange hors système n'y figure pas."
          : "Changements TRACÉS uniquement — décrire n'est pas expliquer : vérifier la cause (inspect_record) avant d'en tirer une décision.",
      });
    },
  },
];
