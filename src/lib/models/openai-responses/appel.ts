/**
 * Adaptateur Responses — L'APPEL NON STREAMÉ, avec ses reprises et la mémoire des coupures
 * d'intermédiaires réseau (502/504/522/524) qui fait partir les appels suivants en flux.
 */
import { providerErrorMessage, isRetryableStatus } from "../errors";
import { noterEnTetes, noter429, noterSucces } from "../throttle";
import { budgetDeSecours, BUDGET_POLICY } from "../budget";
import { type ModelBinding, type ModelCallOptions, type ModelReply, type ModelTurn, emptyUsage } from "../contract";
import { attendu } from "@/lib/journal";
import { budgetEpuise, buildResponsesBody, fromResponsesOutput, lireRecherchesWeb, type RespPayload, sansCle, stopOfResponse, urlDe } from "./format";
import { journaliserBudget, usageDe } from "./usage";
import { streamOpenAiResponses } from "./flux";

/**
 * UN APPEL. Ne lève jamais — même règle que l'autre adaptateur : une exception qui traverse une
 * boucle d'agent perd l'usage déjà consommé, donc le coût déjà payé.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE RÉPONSE QUI MET TROP LONGTEMPS À COMMENCER EST PERDUE — et la rejouer la reperd.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Le banc de la chaîne humaine ne démarrait pas : chaque `mission.plan` rendait
 * « 502 upstream request failed », trois fois de suite, et la mission naissait sans étape.
 * La mesure a écarté les causes plausibles une à une :
 *
 *   • le modèle est sain      — 10 petits appels : 10 × 200 ;
 *   • la taille n'est pas en cause — 45 Ko, 226 Ko, 566 Ko, 1,3 Mo : 200 à chaque fois ;
 *   • une génération LONGUE, elle, tombe — 502 à 30 s EXACTEMENT, trois fois sur trois ;
 *   • la MÊME requête en flux passe — 200 en 39 s et 46 s, 3 000+ événements.
 *
 * Ce n'est donc pas le fournisseur : c'est un intermédiaire qui ferme une connexion restée
 * muette ~30 s. Un proxy d'entreprise, un répartiteur de charge, une passerelle d'hébergeur :
 * tous en ont un, et le nôtre n'est pas le seul chemin où Adam tournera.
 *
 * ── LA RÈGLE, ET POURQUOI ELLE N'EST PAS UN CONTOURNEMENT ───────────────────────────────
 *
 * Le recours est NOMMÉ PAR SA CAUSE : 502/504/522/524 sont des coupures d'intermédiaire, jamais
 * des refus du modèle. On rejoue alors EN FLUX — les octets partent tout de suite, aucun silence
 * ne s'installe, aucun intermédiaire n'a de raison de couper. Rejouer à l'identique, lui,
 * reperdrait à l'identique.
 *
 * ── POURQUOI LE FLUX N'EST PAS LE CHEMIN PAR DÉFAUT ─────────────────────────────────────
 *
 * Parce qu'il coûterait une protection. Le chemin simple porte la boucle de réessai ET le
 * rattrapage de budget (`budgetEpuise` → plafond élargi → rejeu), que le flux n'a pas. Router
 * tout le raisonnement vers le flux « au cas où » supprimerait ce filet en silence — le genre
 * d'échange qu'on ne remarque qu'en production. Le flux reste donc le RECOURS, pas la règle.
 *
 * ── ET LA SECONDE COUPURE NE SE PAIE PAS ────────────────────────────────────────────────
 *
 * Payer 30 s de silence avant chaque reprise reviendrait à redécouvrir la même chose à chaque
 * appel. Le modèle qui vient d'être coupé est donc NOTÉ, et les appels suivants partent
 * directement en flux pendant quelques minutes. C'est une MESURE du chemin réseau, pas une
 * hypothèse : là où aucun intermédiaire ne coupe (une production sans proxy bavard), rien n'est
 * jamais noté et rien ne change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const COUPURE_INTERMEDIAIRE = new Set([502, 504, 522, 524]);

/** Le modèle coupé récemment → on part en flux sans repayer le silence. Effacé par le temps. */
const COUPES = new Map<string, number>();

const MEMOIRE_COUPURE_MS = 10 * 60 * 1000;

const cheminCoupeRecemment = (model: string): boolean => {
  const t = COUPES.get(model);
  if (t === undefined) return false;
  if (Date.now() - t > MEMOIRE_COUPURE_MS) { COUPES.delete(model); return false; }
  return true;
};

/** Le flux employé comme TRANSPORT : personne ne lit les fragments, seul le résultat compte. */
const viaFlux = (binding: ModelBinding, turns: ModelTurn[], opts: ModelCallOptions): Promise<ModelReply> =>
  streamOpenAiResponses(binding, turns, opts, () => {});

/** Pour les tests : oublier ce qui a été mesuré du chemin réseau. */
export function oublierCoupures(): void {
  COUPES.clear();
}

export async function callOpenAiResponses(
  binding: ModelBinding,
  turns: ModelTurn[],
  opts: ModelCallOptions = {},
): Promise<ModelReply> {
  const started = Date.now();
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return sansCle(binding);

  // Ce chemin a DÉJÀ coupé sur ce modèle : inutile de repayer le silence pour le redécouvrir.
  if (cheminCoupeRecemment(binding.model)) return viaFlux(binding, turns, opts);

  const body = buildResponsesBody(binding, turns, opts);

  let lastError = "Appel au modèle impossible (réseau).";
  let grewBudget = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(urlDe(), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });

      // LA PORTE ÉCOUTE (§60) : les soldes annoncés nourrissent la concurrence adaptative, et un
      // 429 la divise en respectant `Retry-After`. C'est ici que les faits arrivent — l'adaptateur
      // les transmet, la porte décide.
      noterEnTetes(res.headers);
      if (res.status === 429) noter429(res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset-requests"));

      if (res.ok) {
        noterSucces();
        const data = (await res.json()) as RespPayload;
        const blocks = fromResponsesOutput(data.output);
        const web = lireRecherchesWeb(data.output);
        const plafond = Number(body.max_output_tokens ?? 0) || null;

        // LES QUATRE NOMBRES, à chaque appel — c'est ce qui rend la politique de budget
        // corrigeable sur des faits plutôt que sur une impression.
        journaliserBudget(binding, plafond, data.usage, data);

        // LE RATTRAPAGE, restreint à la SEULE cause qu'il sait traiter.
        //
        // Il rejouait auparavant toute réponse vide et incomplète — y compris un `content_filter`,
        // où agrandir le budget ne peut rien changer et fait juste payer l'appel deux fois. Il ne
        // se déclenche donc plus que sur `max_output_tokens`, et son déclenchement est désormais
        // une ANOMALIE : la passerelle a calculé un budget exprès, s'il ne suffit pas c'est la
        // politique qui est fausse. Le journal le dit dans ces termes.
        //
        // ET IL COUVRE AUSSI LA RÉPONSE TRONQUÉE, pas seulement la vide. Le Run 4 a montré le
        // trou : 1 626 jetons visibles rendus AVANT le plafond → `blocks` non vide → aucun
        // rattrapage → la synthèse coupée en plein vol descendait la chaîne, tuait l'étape, et
        // la mission mourait BLOCKED. Agir sur une réponse tronquée est pire qu'un appel payé
        // deux fois — même règle que pour la réponse vide, borné à UNE relance (`grewBudget`).
        if (budgetEpuise(data) && !grewBudget) {
          grewBudget = true;
          const courant = Number(body.max_output_tokens ?? 0) || BUDGET_POLICY.RESERVE_RAISONNEMENT.medium;
          const relance = budgetDeSecours(courant);
          body.max_output_tokens = relance;
          console.warn(
            `[models] ${binding.role}/${binding.model} — le budget calculé n'a PAS suffi `
            + `(${courant} → ${relance}, raisonnement ${data.usage?.output_tokens_details?.reasoning_tokens ?? "?"} jetons). `
            + "La réserve de raisonnement de src/lib/models/budget.ts est à revoir : ce rattrapage "
            + "paie l'appel deux fois et ne doit pas devenir la normale.",
          );
          continue;
        }

        if (data.status === "failed") {
          return {
            ok: false,
            configured: true,
            stop: "error",
            blocks: [],
            usage: usageDe(binding, data.usage, started, attempt, {
              maxOutputTokens: plafond,
              incompleteReason: data.incomplete_details?.reason ?? null,
              // Les recherches d'un appel ÉCHOUÉ se paient quand même — elles se comptent.
              webSearchCalls: web.recherches,
            }),
            error: data.error?.message || "Le modèle a échoué sans message.",
          };
        }

        return {
          ok: true,
          configured: true,
          stop: stopOfResponse(data, blocks.some((b) => b.type === "tool_call")),
          blocks,
          usage: usageDe(binding, data.usage, started, attempt, {
            maxOutputTokens: plafond,
            // Renseigné SEULEMENT quand la réponse est réellement incomplète : mettre la raison
            // partout ferait passer un arrêt normal pour une coupure.
            incompleteReason: data.status === "incomplete" ? (data.incomplete_details?.reason ?? "incomplete") : null,
            webSearchCalls: web.recherches,
          }),
          ...(data.id ? { responseId: data.id } : {}),
          ...(web.sources.length ? { webSources: web.sources } : {}),
        };
      }

      const raw = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      lastError = providerErrorMessage(res.status, raw);

      // ── AUCUN RATTRAPAGE DE PARAMÈTRE ICI, ET C'EST LE POINT DE TOUT LE CHANTIER ────────
      //
      // Il y en avait deux : un pour `reasoning_effort`, un pour `temperature`. Chacun retirait
      // le champ fautif et rejouait. Chacun paraissait raisonnable seul ; ensemble, ils
      // formaient une méthode — envoyer au hasard, puis retirer ce qu'OpenAI refuse — et cette
      // méthode ne converge jamais. Elle produit un troisième 400, puis un quatrième.
      //
      // Désormais, un paramètre interdit n'est PAS construit (`buildResponsesBody` interroge
      // `capabilities.ts` champ par champ). Il n'y a donc plus rien à retirer.
      //
      // Si un 400 « unsupported parameter » revient malgré tout, c'est une VRAIE nouvelle :
      // OpenAI a changé sa contrainte, et il manque une ligne au registre. On veut le voir, pas
      // le contourner — d'où l'avertissement explicite plutôt qu'un `delete` silencieux.
      if (res.status === 400 && /unsupported parameter|not supported with this model/i.test(raw)) {
        console.error(
          `[models] CONTRAINTE FOURNISSEUR INCONNUE pour ${binding.model} : ${raw.slice(0, 200)}\n`
          + "  → il manque une entrée dans src/lib/models/capabilities.ts. "
          + "NE PAS corriger en retirant le champ à la volée : la contrainte doit être connue AVANT le réseau.",
        );
      }

      console.error("[models] openai responses error", binding.role, binding.model, res.status, raw.slice(0, 300));

      // LE RECOURS EST NOMMÉ PAR SA CAUSE. Une coupure d'intermédiaire ne se répare pas en
      // rejouant à l'identique — elle se répare en cessant de laisser la connexion muette.
      if (COUPURE_INTERMEDIAIRE.has(res.status)) {
        COUPES.set(binding.model, Date.now());
        console.warn(
          `[models] ${binding.role}/${binding.model} — HTTP ${res.status} après ${Date.now() - started} ms : `
          + "coupure d'intermédiaire, pas un refus du modèle. Reprise EN FLUX (le même appel, "
          + "des octets tout de suite).",
        );
        return viaFlux(binding, turns, opts);
      }
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) break;
    } catch (err) {
      if (opts.signal?.aborted) {
        lastError = "Appel interrompu.";
        break;
      }
      console.error(`[models] openai responses failed (${binding.role}, tentative ${attempt})`, err);
      lastError = "Appel au modèle impossible (réseau ou délai dépassé).";
      if (attempt === MAX_ATTEMPTS) break;
    }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }

  return {
    ok: false,
    configured: true,
    stop: "error",
    blocks: [],
    usage: { ...emptyUsage(binding.role, binding.model, "openai"), ms: Date.now() - started },
    error: lastError,
  };
}
