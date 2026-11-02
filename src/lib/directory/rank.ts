import { DirectoryChannel, EndpointConfidence } from "@prisma/client";

/**
 * QUELLE ADRESSE GAGNE — la décision, isolée et pure.
 *
 * C'est la partie délicate de l'annuaire, et c'est pour ça qu'elle ne touche pas la base : elle
 * se teste ligne à ligne. Deux règles la gouvernent, et elles ne sont pas de même nature.
 *
 * LA PREMIÈRE EST UNE RÈGLE DE CONFIANCE. Une adresse saisie et vérifiée par l'assistante de
 * direction vaut mieux qu'une adresse aperçue dans un vieux fil de discussion. On préfère donc
 * toujours le VÉRIFIÉ à l'OBSERVÉ, et l'observé au DÉDUIT — jamais l'inverse, même si le déduit
 * « ressemble » davantage à ce qu'on cherche.
 *
 * LA SECONDE EST UNE RÈGLE DE PRUDENCE. Quand deux adresses vérifiées restent en lice — la
 * Pharmagene et la Gmail de la même personne —, on ne tranche PAS : on laisse les deux remonter,
 * et l'appelant pose UNE question courte. Deviner ici ferait partir un message professionnel sur
 * une boîte personnelle, ou l'inverse. Une question de six mots coûte moins cher.
 */

export interface ResolvedEndpoint {
  channel: DirectoryChannel;
  value: string;
  label: string | null;
  confidence: EndpointConfidence;
  isPrimary: boolean;
  source: string;
}

export interface PersonMatch {
  /** Clé de dédoublonnage — l'identifiant canonique quand il existe. */
  key: string;
  name: string;
  jobTitle: string | null;
  company: string | null;
  userId: string | null;
  employeeId: string | null;
  contactId: string | null;
  directoryEntryId: string | null;
  /** Le N+1 et le département de la fiche RH, quand la personne en a une (banc V4-H : « son manager n'est pas indiqué »). */
  manager?: string | null;
  department?: string | null;
  endpoints: ResolvedEndpoint[];
}

/** Le poids d'une provenance. Plus c'est haut, plus l'entreprise en répond. */
const CONFIDENCE_WEIGHT: Record<EndpointConfidence, number> = {
  [EndpointConfidence.VERIFIED_INTERNAL]: 4,
  [EndpointConfidence.VERIFIED_PROVIDER]: 3,
  [EndpointConfidence.OBSERVED_HISTORY]: 2,
  [EndpointConfidence.INFERRED]: 1,
};

/** Comparable pour la recherche : sans accents, sans casse, sans ponctuation. */
export function normalizeName(raw: string): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Deux fois la même adresse (deux sources) ne doit apparaître qu'UNE fois — la mieux notée. */
export function rankEndpoints(endpoints: readonly ResolvedEndpoint[]): ResolvedEndpoint[] {
  const best = new Map<string, ResolvedEndpoint>();
  for (const e of endpoints) {
    const key = `${e.channel}:${e.value.toLowerCase()}`;
    const kept = best.get(key);
    if (!kept) { best.set(key, e); continue; }
    // Même adresse vue par deux sources : on garde la provenance la plus forte, et on hérite du
    // caractère « principal » dès que l'une des deux le porte.
    const better = CONFIDENCE_WEIGHT[e.confidence] > CONFIDENCE_WEIGHT[kept.confidence] ? e : kept;
    best.set(key, { ...better, isPrimary: kept.isPrimary || e.isPrimary });
  }
  return [...best.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return CONFIDENCE_WEIGHT[b.confidence] - CONFIDENCE_WEIGHT[a.confidence];
  });
}

/** Ce que l'appelant doit faire d'un jeu d'adresses : écrire, choisir, ou renoncer. */
export type AddressDecision =
  | { kind: "send"; address: ResolvedEndpoint }
  | { kind: "ask"; options: ResolvedEndpoint[] }
  | { kind: "none" };

/**
 * DÉCIDE — écrire tout de suite, demander laquelle, ou dire qu'on n'a rien.
 *
 * `hint` est ce que le PDG a lâché en passant (« de Pharmagene », « sur sa Gmail ») : un mot
 * suffit à lever l'ambiguïté, et c'est très souvent ce qui arrive. On le cherche dans le libellé
 * ET dans le domaine de l'adresse — « Pharmagene » désigne aussi bien l'étiquette que le domaine.
 */
export function decideAddress(endpoints: readonly ResolvedEndpoint[], hint?: string | null): AddressDecision {
  const mails = endpoints.filter((e) => e.channel === DirectoryChannel.EMAIL);
  if (mails.length === 0) return { kind: "none" };

  // L'INDICE EST UNE PHRASE, PAS UNE ÉTIQUETTE. Le PDG dit « sa Gmail », « de Pharmagene »,
  // « sur son adresse pro » — jamais le libellé exact. On cherche donc chaque MOT porteur de
  // l'indice dans l'étiquette et dans l'adresse ; exiger la phrase entière ne matcherait
  // jamais rien, et l'on reposerait une question déjà tranchée.
  const words = normalizeName(hint ?? "").split(" ").filter((w) => w.length >= 3);
  if (words.length > 0) {
    const matched = mails.filter((e) => {
      const haystack = normalizeName(`${e.label ?? ""} ${e.value}`);
      return words.some((w) => haystack.includes(w));
    });
    if (matched.length === 1) return { kind: "send", address: matched[0] };
    if (matched.length > 1) return { kind: "ask", options: matched };
  }

  const ranked = rankEndpoints(mails);
  if (ranked.length === 1) return { kind: "send", address: ranked[0] };

  // Une adresse explicitement marquée PRINCIPALE tranche : c'est le geste que l'assistante de
  // direction a posé exprès pour éviter la question.
  const primaries = ranked.filter((e) => e.isPrimary);
  if (primaries.length === 1) return { kind: "send", address: primaries[0] };

  // Sinon, seules les MIEUX notées restent en lice. Si une seule domine, on l'envoie ; si
  // plusieurs sont à égalité de confiance, on demande — c'est le cas « Pharmagene ou Gmail ? ».
  const top = CONFIDENCE_WEIGHT[ranked[0].confidence];
  const contenders = ranked.filter((e) => CONFIDENCE_WEIGHT[e.confidence] === top);
  return contenders.length === 1 ? { kind: "send", address: contenders[0] } : { kind: "ask", options: contenders };
}

/** « Amine : Pharmagene ou Gmail ? » — la question la plus courte qui lève l'ambiguïté. */
export function askWhichAddress(name: string, options: readonly ResolvedEndpoint[]): string {
  const labels = options.map((o) => o.label?.trim() || domainLabel(o.value));
  return `${name} : ${labels.join(" ou ")} ?`;
}

/** Le domaine, rendu lisible — « pharmagenedz.com » → « Pharmagenedz ». */
export function domainLabel(address: string): string {
  const domain = address.split("@")[1] ?? address;
  const root = domain.split(".")[0] ?? domain;
  return root.charAt(0).toUpperCase() + root.slice(1);
}
