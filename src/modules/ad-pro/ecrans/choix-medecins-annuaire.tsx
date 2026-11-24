"use client";

import * as React from "react";
import { Check, ChevronDown, Loader2, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { chercherMedecinsAnnuaire } from "../actions-medecins";
import { LIBELLE_ROLE_MEDECIN, ROLES_MEDECIN, type RoleMedecin } from "../domaine/medecins-concernes";

/**
 * LA LISTE DÉROULANTE DE L'ANNUAIRE (recette 24/11/2026) — « Médecins concernés » se choisit comme un menu, plusieurs à la fois.
 *
 * Avant, il fallait taper deux lettres pour voir un nom, et chaque clic reliait UN médecin : dix orateurs, dix recherches. Un clic
 * dans le champ ouvre maintenant l'annuaire ENTIER (par ordre alphabétique, plafonné côté serveur — la liste dit quand elle est
 * tronquée) ; taper filtre sur le nom, la spécialité, l'établissement ; on coche ; un seul bouton relie tous les cochés avec le
 * rôle choisi. Les médecins déjà reliés sont cochés d'office et grisés.
 *
 * LES COCHÉS RESTENT À L'ÉCRAN QUOI QU'ON TAPE (la règle de `MultiSelectField`) : chercher un second nom ne doit pas faire
 * disparaître le premier — on décocherait par réflexe ce qu'on croit avoir perdu.
 *
 * Clavier : flèches pour parcourir, Entrée pour cocher, Échap pour fermer ; un clic ou une tabulation hors de la zone ferme aussi.
 * Le champ de rôle est DANS la zone : le changer ne ferme pas la liste.
 */
type Annuaire = Awaited<ReturnType<typeof chercherMedecinsAnnuaire>>;
type MedecinAnnuaire = Annuaire["medecins"][number];

/** La comparaison du filtre : sans casse ni accents (« Zerrouki » = « zérrouki »), chaque mot tapé doit se retrouver. */
function sansAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function correspond(m: MedecinAnnuaire, mots: string[]): boolean {
  const botte = sansAccents([m.nom, m.specialite, m.etablissement].filter(Boolean).join(" "));
  return mots.every((w) => botte.includes(w));
}

export function ChoixMedecinsAnnuaire({ deja, role, onRole, occupe, onAjouter }: {
  /** Les praticiens déjà reliés à la demande : cochés d'office, non cochables. */
  deja: ReadonlySet<string>;
  role: RoleMedecin;
  onRole: (r: RoleMedecin) => void;
  occupe: boolean;
  /** Relie les cochés ; `true` quand c'est fait (la liste se vide et se ferme). */
  onAjouter: (doctorIds: string[]) => Promise<boolean>;
}) {
  const zone = React.useRef<HTMLDivElement>(null);
  const champ = React.useRef<HTMLInputElement>(null);
  const listeId = React.useId();
  const [ouvert, setOuvert] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [annuaire, setAnnuaire] = React.useState<Annuaire | null>(null);
  const [recherche, setRecherche] = React.useState<{ q: string; resultat: Annuaire } | null>(null);
  const [charge, setCharge] = React.useState(false);
  const [erreurLecture, setErreurLecture] = React.useState<string | null>(null);
  const [essai, setEssai] = React.useState(0);
  const [coches, setCoches] = React.useState<ReadonlyMap<string, MedecinAnnuaire>>(() => new Map());
  const [actif, setActif] = React.useState(-1);

  // L'ANNUAIRE SE LIT À LA PREMIÈRE OUVERTURE, sans rien taper — une fois : refermer la liste n'annule pas la lecture.
  const vivant = React.useRef(true);
  React.useEffect(() => { vivant.current = true; return () => { vivant.current = false; }; }, []);
  const lectureLancee = React.useRef(false);
  const lireAnnuaire = React.useCallback(() => {
    if (lectureLancee.current) return;
    lectureLancee.current = true;
    setCharge(true); setErreurLecture(null);
    const fd = new FormData();
    fd.set("q", "");
    chercherMedecinsAnnuaire(fd)
      .then((r) => { if (vivant.current) setAnnuaire(r); })
      .catch(() => {
        lectureLancee.current = false;
        if (vivant.current) setErreurLecture("L'annuaire n'a pas pu être lu.");
      })
      .finally(() => { if (vivant.current) setCharge(false); });
  }, []);

  // UN ANNUAIRE TRONQUÉ SE FILTRE AU SERVEUR : ce qui n'est pas dans les premiers noms doit rester trouvable.
  const t = q.trim();
  const parServeur = Boolean(annuaire?.tronque) && t.length > 0;
  React.useEffect(() => {
    if (!parServeur) return;
    let annule = false;
    const minuteur = setTimeout(() => {
      const fd = new FormData();
      fd.set("q", t);
      chercherMedecinsAnnuaire(fd)
        .then((r) => { if (!annule) { setRecherche({ q: t, resultat: r }); setErreurLecture(null); } })
        .catch(() => { if (!annule) setErreurLecture("La recherche dans l'annuaire a échoué."); });
    }, 250);
    return () => { annule = true; clearTimeout(minuteur); };
  }, [parServeur, t, essai]);
  const chercheEnCours = parServeur && recherche?.q !== t && !erreurLecture;

  const trouves = React.useMemo<MedecinAnnuaire[]>(() => {
    if (!annuaire) return [];
    if (!t) return annuaire.medecins;
    if (annuaire.tronque) return recherche?.resultat.medecins ?? [];
    const mots = sansAccents(t).split(/\s+/).filter(Boolean);
    return annuaire.medecins.filter((m) => correspond(m, mots));
  }, [annuaire, t, recherche]);
  // Les cochés hors du filtre (ou trouvés au-delà du plafond) restent en tête de liste.
  const lignes = React.useMemo(() => {
    const vus = new Set(trouves.map((m) => m.id));
    const horsListe = [...coches.values()].filter((m) => !vus.has(m.id));
    return horsListe.length > 0 ? [...horsListe, ...trouves] : trouves;
  }, [trouves, coches]);
  const tronqueAffiche = !t ? Boolean(annuaire?.tronque) : parServeur && Boolean(recherche?.resultat.tronque);

  React.useEffect(() => {
    if (!ouvert || actif < 0) return;
    document.getElementById(`${listeId}-${actif}`)?.scrollIntoView({ block: "nearest" });
  }, [ouvert, actif, listeId]);

  // UN CLIC HORS DE LA ZONE FERME (le champ de rôle et le pied de liste en font partie).
  React.useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: PointerEvent) => {
      if (zone.current && !zone.current.contains(e.target as Node)) setOuvert(false);
    };
    document.addEventListener("pointerdown", dehors);
    return () => document.removeEventListener("pointerdown", dehors);
  }, [ouvert]);

  const basculer = (m: MedecinAnnuaire) => {
    if (deja.has(m.id) || occupe) return;
    setCoches((avant) => {
      const apres = new Map(avant);
      if (apres.has(m.id)) apres.delete(m.id); else apres.set(m.id, m);
      return apres;
    });
  };
  const ouvrir = () => { setOuvert(true); if (!annuaire) lireAnnuaire(); };
  const reessayer = () => {
    setErreurLecture(null);
    if (!annuaire) lireAnnuaire(); else { setRecherche(null); setEssai((x) => x + 1); }
  };
  const fermer = (rendreLeFocus: boolean) => {
    setOuvert(false); setActif(-1);
    if (rendreLeFocus) champ.current?.focus();
  };

  const n = coches.size;
  const ajouter = async () => {
    if (n === 0 || occupe) return;
    const fait = await onAjouter([...coches.keys()]);
    if (fait) { setCoches(new Map()); setQ(""); setRecherche(null); fermer(false); }
  };

  const pied = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        {n === 0 ? "Cochez un ou plusieurs médecins." : `${n} médecin${n > 1 ? "s" : ""} coché${n > 1 ? "s" : ""} · ${LIBELLE_ROLE_MEDECIN[role]}`}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {n > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={occupe} onClick={() => setCoches(new Map())}>
            Tout décocher
          </Button>
        )}
        <Button type="button" size="sm" disabled={n === 0 || occupe} onClick={() => void ajouter()}>
          {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
          {n > 1 ? `Ajouter les ${n} médecins` : "Ajouter le médecin"}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      ref={zone}
      className="relative space-y-1.5"
      onBlur={(e) => {
        // Une TABULATION hors de la zone ferme ; un clic dans le vide de la zone (relatedTarget nul) ne ferme pas.
        if (e.relatedTarget && zone.current && !zone.current.contains(e.relatedTarget as Node)) fermer(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && ouvert) { e.preventDefault(); fermer(true); }
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={champ} value={q} autoComplete="off"
            placeholder="Choisir dans l'annuaire (nom, spécialité, établissement)…"
            role="combobox" aria-label="Choisir des médecins dans l'annuaire" aria-autocomplete="list"
            aria-expanded={ouvert} aria-controls={listeId}
            aria-activedescendant={ouvert && actif >= 0 && actif < lignes.length ? `${listeId}-${actif}` : undefined}
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-9 text-base outline-none focus:border-primary/60 sm:text-sm"
            onClick={ouvrir}
            onChange={(e) => { setQ(e.target.value); setActif(-1); ouvrir(); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (!ouvert) { ouvrir(); return; }
                setActif((i) => Math.min(i + 1, lignes.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActif((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && ouvert) {
                e.preventDefault();
                const m = lignes[actif];
                if (m) basculer(m);
              }
            }}
          />
          <button
            type="button" tabIndex={-1} aria-label={ouvert ? "Fermer la liste de l'annuaire" : "Ouvrir la liste de l'annuaire"}
            onClick={() => {
              if (ouvert) { fermer(true); return; }
              ouvrir(); champ.current?.focus();
            }}
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
          >
            {charge || chercheEnCours
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              : <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", ouvert && "rotate-180")} aria-hidden />}
          </button>
        </div>
        <select
          value={role} onChange={(e) => onRole(e.target.value as RoleMedecin)} aria-label="Rôle des médecins ajoutés"
          className="h-9 rounded-md border border-input bg-background px-2 text-base sm:text-sm"
        >
          {ROLES_MEDECIN.map((r) => <option key={r} value={r}>{LIBELLE_ROLE_MEDECIN[r]}</option>)}
        </select>
      </div>

      {!ouvert && n > 0 && pied}

      {ouvert && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          {erreurLecture ? (
            <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span className="text-destructive" role="alert">{erreurLecture}</span>
              <Button type="button" variant="outline" size="sm" onClick={reessayer}>Réessayer</Button>
            </div>
          ) : !annuaire ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Lecture de l&apos;annuaire…
            </p>
          ) : (
            <>
              <ul
                id={listeId} role="listbox" aria-multiselectable="true" aria-label="Annuaire des praticiens"
                className={cn("max-h-72 overflow-y-auto p-1", lignes.length === 0 && "hidden")}
                // Un clic dans la liste garde le focus dans le champ : le clavier continue de servir.
                onMouseDown={(e) => e.preventDefault()}
              >
                {lignes.map((m, i) => {
                  const relie = deja.has(m.id);
                  const coche = relie || coches.has(m.id);
                  return (
                    <li
                      key={m.id} id={`${listeId}-${i}`} role="option" aria-selected={coche} aria-disabled={relie || undefined}
                      onClick={() => { setActif(i); basculer(m); }}
                      className={cn(
                        "flex items-start gap-2.5 rounded px-2 py-2.5 text-sm sm:py-1.5",
                        relie ? "cursor-default opacity-60" : "cursor-pointer hover:bg-secondary",
                        i === actif && "bg-secondary",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          coche ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
                        )}
                      >
                        {coche && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium">
                          {m.nom}
                          {relie && <span className="font-normal text-muted-foreground"> — déjà relié·e</span>}
                        </span>
                        <span className="block break-words text-xs text-muted-foreground">
                          {[m.specialite, m.etablissement].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {lignes.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {chercheEnCours ? "Recherche dans l'annuaire…" : t ? <>Aucun praticien trouvé pour « {t} ».</> : "L'annuaire des praticiens est vide."}
                </p>
              )}
              {tronqueAffiche && (
                <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                  {t
                    ? `Plus de ${recherche?.resultat.medecins.length ?? 0} résultats : seuls les premiers par ordre alphabétique sont listés — précisez la recherche.`
                    : `Seuls les ${annuaire.medecins.length} premiers praticiens par ordre alphabétique sont listés — tapez un nom pour trouver les autres.`}
                </p>
              )}
              <div className="border-t border-border p-2">{pied}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
