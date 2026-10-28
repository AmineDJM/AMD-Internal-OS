"use server";

import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan } from "@/lib/rbac";
import {
  CHEMIN_API_JS, diagnosticVariables, formeUrl, lireErreur, messageErreurReseau, pointRetourDocumentServer, rapportOk,
  urlApplication, verdictApiJs, verdictHealthcheck, verdictRouteApplication,
  type ErreurReseau, type PointDiagnostic, type RapportEditeurOffice,
} from "@/lib/onlyoffice-diagnostic";
import { attendu } from "@/lib/journal";

/**
 * TESTER L'ÉDITEUR OFFICE — Super Admin uniquement (Administration, à côté du test du stockage).
 *
 * Une LECTURE : aucune écriture en base, aucun fichier touché. Trois appels sortants, bornés à
 * 8 s chacun, vers des adresses qui viennent de la configuration du serveur — jamais d'une saisie.
 * Le secret JWT n'apparaît jamais dans le rapport : seulement « défini, N caractères ».
 *
 * L'interprétation (adresse, code HTTP, erreur réseau → phrase française) vit dans
 * `onlyoffice-diagnostic.ts`, module pur testé.
 */

const DELAI_MS = 8_000;

type Sonde =
  | { ok: true; status: number; type: string; corps: string; location: string | null; routage: string | null }
  | { ok: false; erreur: ErreurReseau };

async function sonder(url: string, opts: { lireCorps: boolean; suivre: boolean }): Promise<Sonde> {
  try {
    const r = await fetch(url, {
      cache: "no-store",
      redirect: opts.suivre ? "follow" : "manual",
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const corps = opts.lireCorps ? (await r.text()).slice(0, 2_000) : "";
    if (!opts.lireCorps) await r.body?.cancel().catch(attendu("fermeture au mieux : le flux est abandonné de toute façon"));
    return { ok: true, status: r.status, type: r.headers.get("content-type") ?? "", corps, location: r.headers.get("location"), routage: r.headers.get("x-render-routing") };
  } catch (e) {
    return { ok: false, erreur: lireErreur(e) };
  }
}

function hoteDe(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function pointReseau(cle: string, libelle: string, erreur: ErreurReseau, url: string): PointDiagnostic {
  const m = messageErreurReseau(erreur, hoteDe(url), DELAI_MS / 1000);
  return { cle, libelle, etat: "echec", detail: m.detail, correctif: m.correctif };
}

export async function testerEditeurOffice(): Promise<RapportEditeurOffice> {
  const user = await enLecture(requireUser);
  if (user.role !== "SUPER_ADMIN" || !userCan(user, "ADMIN", "UPDATE")) {
    return { ok: false, error: "Réservé au Super Admin.", points: [], apiJs: null, serveurJoint: false };
  }

  const env = process.env as Record<string, string | undefined>;
  const points: PointDiagnostic[] = [...diagnosticVariables(env)];

  // Même lecture que `src/lib/onlyoffice.ts` : barre finale retirée.
  const brutEditeur = (env.ONLYOFFICE_URL ?? "").trim();
  const editeur = brutEditeur.replace(/\/+$/, "");
  const app = urlApplication(env);

  const forme = formeUrl(brutEditeur, "editeur");
  if (brutEditeur) points.push(forme);
  if (app) points.push(formeUrl(app, "application"));

  let serveurJoint = false;
  let apiJs: string | null = null;
  let adresseLisible = false;
  try { new URL(editeur); adresseLisible = Boolean(editeur); } catch { /* adresse illisible : rien à appeler */ }

  if (adresseLisible) {
    apiJs = `${editeur}${CHEMIN_API_JS}`;
    const [sante, script] = await Promise.all([
      sonder(`${editeur}/healthcheck`, { lireCorps: true, suivre: true }),
      sonder(apiJs, { lireCorps: false, suivre: true }),
    ]);
    points.push(sante.ok ? verdictHealthcheck(sante.status, sante.corps, sante.routage)
      : pointReseau("healthcheck", "Serveur d'édition (depuis notre serveur)", sante.erreur, editeur));
    if (script.ok) {
      const p = verdictApiJs(script.status, script.type, script.routage);
      serveurJoint = p.etat === "ok";
      points.push(p);
    } else {
      points.push(pointReseau("api-js", "Script de l'éditeur api.js (depuis notre serveur)", script.erreur, apiJs));
    }

    // En http:// : le navigateur ira en https:// — on regarde si quelque chose y répond.
    if (/^http:\/\//i.test(editeur)) {
      const enHttps = editeur.replace(/^http:/i, "https:");
      const s = await sonder(`${enHttps}/healthcheck`, { lireCorps: true, suivre: true });
      const ok = s.ok && s.status === 200 && s.corps.trim().toLowerCase() === "true";
      points.push(ok
        ? { cle: "variante-https", libelle: "La même adresse en https://", etat: "attention", detail: "Répond en https:// : il suffit de corriger la variable.", correctif: `ONLYOFFICE_URL = ${enHttps}` }
        : { cle: "variante-https", libelle: "La même adresse en https://", etat: "echec", detail: s.ok ? `Code ${s.status} en https:// : c'est là que le navigateur va, et rien n'y répond.` : `En https:// : ${messageErreurReseau(s.erreur, hoteDe(enHttps), DELAI_MS / 1000).detail}`, correctif: "Servir le Document Server en HTTPS (reverse-proxy + certificat reconnu)." });
    }
  } else if (brutEditeur) {
    points.push({ cle: "healthcheck", libelle: "Serveur d'édition (depuis notre serveur)", etat: "info", detail: "Non testé : adresse illisible." });
  }

  let appLisible = false;
  try { new URL(app); appLisible = Boolean(app); } catch { /* adresse illisible */ }
  if (appLisible) {
    const base = app.replace(/\/+$/, "");
    const r = await sonder(`${base}/api/onlyoffice/file`, { lireCorps: false, suivre: false });
    points.push(r.ok ? verdictRouteApplication(r.status, r.location)
      : pointReseau("route-application", "Retour vers l'application (/api/onlyoffice/file)", r.erreur, base));
  }
  points.push(pointRetourDocumentServer(app));

  return { ok: rapportOk(points), points, apiJs, serveurJoint };
}
