import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticate, requireScopes, type ApiContext } from "./auth";
import { ApiError, errors } from "./errors";
import type { Scope } from "./scopes";
import { sansBloquer } from "@/lib/journal";

/**
 * LE PASSAGE OBLIGÉ DE TOUT APPEL D'API.
 *
 * Authentifier, vérifier les portées, journaliser, dédoublonner les rejeux, envelopper les
 * erreurs : ces cinq gestes ne se répètent pas dans chaque route. Ils vivent ici, une fois, et
 * toute route qui les oublierait n'existerait tout simplement pas — puisqu'elle passe par
 * `handle()` pour être écrite.
 *
 * L'identifiant de corrélation est émis à l'entrée et rendu dans l'en-tête `X-Correlation-Id`
 * comme dans le corps d'erreur : un agent qui signale un problème donne ce numéro, et on
 * retrouve l'appel exact dans `ApiCall`.
 */

export interface HandlerArgs<P = Record<string, string>> {
  req: NextRequest;
  ctx: ApiContext;
  params: P;
  /** À renseigner pour que le journal dise SUR QUOI l'appel a porté. */
  mark: (info: { operationId?: string; entityType?: string; entityId?: string; before?: unknown; after?: unknown }) => void;
}

export interface HandleOptions {
  operationId: string;
  scopes: readonly Scope[];
  /** Une écriture : active l'idempotence et la journalisation avant/après. */
  write?: boolean;
}

const json = (body: unknown, status: number, correlationId: string, extra: Record<string, string> = {}): NextResponse =>
  NextResponse.json(body, { status, headers: { "X-Correlation-Id": correlationId, "Cache-Control": "no-store", ...extra } });

/** Empreinte du corps : deux requêtes « identiques » doivent l'être vraiment. */
function hashBody(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function handle<P = Record<string, string>>(
  options: HandleOptions,
  fn: (args: HandlerArgs<P>) => Promise<unknown>,
): (req: NextRequest, ctx: { params: P }) => Promise<NextResponse> {
  return async (req, routeCtx) => {
    const started = Date.now();
    const correlationId = req.headers.get("X-Correlation-Id") ?? randomUUID();
    const marks: { operationId?: string; entityType?: string; entityId?: string; before?: unknown; after?: unknown } = {};
    let ctx: ApiContext | null = null;

    try {
      ctx = await authenticate(req.headers.get("authorization"), correlationId);
      requireScopes(ctx, options.scopes);

      // IDEMPOTENCE — un agent rejoue dès qu'il perd la réponse. Sans cela, un incident réseau
      // crée deux dossiers ou valide deux fois. La même clé avec un CORPS DIFFÉRENT n'est pas
      // un rejeu : c'est une erreur d'appelant, et on la dit au lieu de rendre une réponse
      // qui ne correspond pas à la demande.
      const idemKey = req.headers.get("Idempotency-Key");
      let requestHash = "";
      if (options.write && idemKey) {
        const raw = await req.clone().text();
        requestHash = hashBody(raw);
        const seen = await prisma.apiIdempotencyKey.findUnique({
          where: { clientId_key: { clientId: ctx.client.id, key: idemKey } },
        });
        if (seen) {
          if (seen.requestHash !== requestHash) throw errors.idempotencyMismatch();
          return json(seen.response, seen.status, correlationId, { "Idempotency-Replayed": "true" });
        }
      }

      const data = await fn({ req, ctx, params: routeCtx.params, mark: (i) => Object.assign(marks, i) });

      // Une réponse BINAIRE (téléchargement) sort du cadre JSON : elle est rendue telle quelle,
      // après la même authentification, les mêmes portées et la même journalisation.
      if (data instanceof NextResponse) {
        data.headers.set("X-Correlation-Id", correlationId);
        await log(ctx, req, options, marks, data.status, data.ok, null, Date.now() - started, correlationId);
        return data;
      }
      const status = options.write ? 200 : 200;
      const body = { data, correlationId };

      if (options.write && idemKey) {
        // Enregistré APRÈS coup : une clé posée avant l'exécution bloquerait un vrai rejeu
        // après échec, alors que c'est précisément le cas où l'agent doit pouvoir recommencer.
        await prisma.apiIdempotencyKey.create({
          data: { clientId: ctx.client.id, key: idemKey, requestHash, status, response: body as object },
        }).catch(sansBloquer("api-http.handle.apiIdempotencyKey"));
      }

      await log(ctx, req, options, marks, status, true, null, Date.now() - started, correlationId);
      return json(body, status, correlationId);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : errors.internal();
      if (!(err instanceof ApiError)) console.error(`[api] ${options.operationId} a échoué`, err);
      await log(ctx, req, options, marks, apiErr.status, false, apiErr.code, Date.now() - started, correlationId);
      return json(apiErr.body(correlationId), apiErr.status, correlationId);
    }
  };
}

/**
 * JOURNAL DES APPELS. Distinct du journal humain et relié à lui par l'identifiant de
 * corrélation : on doit pouvoir dire « ceci a été fait par l'agent, pas par une personne ».
 * N'échoue jamais l'appel — un journal indisponible ne doit pas empêcher une lecture.
 */
async function log(
  ctx: ApiContext | null,
  req: NextRequest,
  options: HandleOptions,
  marks: { operationId?: string; entityType?: string; entityId?: string; before?: unknown; after?: unknown },
  status: number,
  ok: boolean,
  errorCode: string | null,
  durationMs: number,
  correlationId: string,
): Promise<void> {
  try {
    await prisma.apiCall.create({
      data: {
        clientId: ctx?.client.id ?? null,
        actorUserId: ctx?.user.id ?? null,
        correlationId,
        method: req.method,
        path: new URL(req.url).pathname,
        operationId: marks.operationId ?? options.operationId,
        entityType: marks.entityType ?? null,
        entityId: marks.entityId ?? null,
        status,
        ok,
        errorCode,
        // Prisma distingue « JSON null » de « colonne nulle » : on n'écrit la clé que s'il y
        // a quelque chose à écrire, plutôt que de choisir un null qui ne veut pas dire ça.
        ...(marks.before === undefined ? {} : { before: marks.before as object }),
        ...(marks.after === undefined ? {} : { after: marks.after as object }),
        durationMs,
      },
    });
  } catch (e) {
    console.error("[api] journalisation impossible", e);
  }
}

/** Lecture du corps JSON, avec un refus lisible plutôt qu'une exception brute. */
export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw errors.validation("Corps JSON illisible.");
  }
}
