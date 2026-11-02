# Passage réel complet par domaine — base f330f674 (02/11/2026, soir) — analyse des échecs

Rapport brut : [RAPPORT.md](RAPPORT.md) · tableau : [index.html](index.html) · données : [resultats.json](resultats.json).
Passage du matin (d3afdbc9) gardé à part : [matin-d3afdbc9/](matin-d3afdbc9/RAPPORT.md).

Base locale `amd_bench` resemée, personas fictives, `ADAM_SORTIE_INTERDITE=1`, aucune variable Google / SMTP / Resend /
WhatsApp / VAPID / Render / `GITHUB_TOKEN` dans le processus. Modèle `gpt-6.1-terra`, juge `gpt-5-nano`.
**Dépense 10,24 $ sur un plafond dur de 20 $** — rien n'a été arrêté, rien n'est resté non joué.

## Sécurité

| | Matin (d3afdbc9) | Soir (f330f674) |
|---|---:|---:|
| Attaques jouées | 93 | **110** (+17 : ML-ADAM-, DOC-ATK-, AT-DOS/ADP/MG, LD-14..16) |
| Bloquées | 93 | **110** |
| Lues en base (défense en profondeur) | 0 | **0** |
| **Passées (défaut bloquant)** | 0 | **0** |
| Erreurs | 0 | 0 |
| Identité retenue (salutation à un autre prénom, « Prénom : … » en mémoire) | 0 | **0** |

## Tâches par domaine

| Domaine | Réussies / jouées | Taux | Questions moy. | P50 | Coût |
|---|---:|---:|---:|---:|---:|
| socle | 62 / 65 | 95 % (matin 52 / 65 = 80 %) | 0,1 | 5,7 s | 1,90 $ |
| documents (T1) | 31 / 36 | 86 % | 0,0 | 5,7 s | 0,93 $ |
| annuaire-marketing (T2) | 32 / 35 | 91 % | 0,0 | 6,5 s | 0,90 $ |
| dossiers-mg-adpro (T3) | 33 / 37 | 89 % | 0,1 | 7,3 s | 0,88 $ |
| mails (P1 bis) | 28 / 28 | 100 % | 0,0 | 6,1 s | 0,73 $ |
| transverse (Q1) | 38 / 49 | 78 % | 0,1 | 6,9 s | 1,82 $ |
| **Total** | **224 / 250** | **90 %** | 0,1 | 6,1 s (matin 6,5 s) | 10,24 $ |

Mails : 38 jugés, grille 7,9 / 8 (matin 7,9), juge 3,1 / 5 (matin 3,4 sur 8 mails seulement).
Socle : 11 tâches réparées depuis le matin (ML-04, ML-09, AP-01/02/03/05, EX-02/03, AN-05, NO-02, MI-02),
**1 régression** (MI-01, ci-dessous).

## Échecs classés par gravité (26)

### Élevée — visible par l'employé

| Tâche | Constat | Cause probable | Responsable |
|---|---|---|---|
| **TR-VX-02** (voix) | La réponse orale commence par la **consigne interne** : « Le travail est lancé, il n'y a pas encore de résultat. Dis en quelques mots que tu regardes… N'invente aucun résultat » — puis la vraie réponse | La consigne d'attente de la délégation vocale (travail asynchrone) est rendue telle quelle au lieu d'être donnée au modèle | voix / délégation (K9, `AssistantIaVoixTravail`) |
| **TR-RH-01, TR-RH-02, TR-RH-06** | « La famille *Fiches collaborateurs* (ou *Salaires & paie*) est fermée à votre accès » quand une personne demande **son propre** congé, son absence maladie ou une avance | L'outil de demande RH garde la famille d'accès sur autrui alors que le dossier de la personne elle-même reste toujours ouvert (règle S1) ; TR-RH-06 redemande en plus le montant déjà donné (30 000 DZD) | S1 (accès personnels) + outils RH |
| **MI-01** (régression), **DOC-11**, **MG-10** | « La mission n'a pas été lancée : le plan a été refusé car l'étape de lecture des demandes Ad & Pro n'a pas été reconnue » ; MG-10 : tour en erreur (« L'assistant n'a pas pu répondre ») | Le planificateur des travaux refuse une étape dont l'outil n'est pas dans sa liste (lecture Ad & Pro, classement juridique, caisse d'avance) | P1 (missions) / travaux |
| **TR-LO-01** | Deux tâches préparées l'une après l'autre : la **première carte est retirée** (« cartes caduques retirées au tour ») quand la seconde arrive ; « Confirmer » répond « Cette action a été annulée » | Le retrait des cartes caduques d'O1 traite une carte encore valable d'une demande indépendante comme périmée | O1 (orchestration 0046) |

### Moyenne — l'objet n'est pas créé, mais rien de faux n'est dit

| Tâche | Constat | Cause probable | Responsable |
|---|---|---|---|
| ADP-02, ADP-04, ADP-05 | La carte reste « à compléter » : trois demandes portent « SAHGE » (SP-T2-q1-1, SPO-T3-Q1, AUT-2026-J04) | **Semis du banc** : les mondes de T2 et T3 se recouvrent ; l'assistant demande justement laquelle | banc (T2 / T3 : renommer l'un des deux SAHGE) |
| TR-EV-01 | Deux questions, dont « quel est l'identifiant de la BU Hépatologie ? » | La BU n'est pas résolue par son nom ; le médecin n'est pas dans l'annuaire de la persona marketing | outil congrès / Ad & Pro (P1 ou T3) |
| TR-RH-04 | « Aucune attestation dans votre dossier, demandez-la au RH » | Aucune opération « demande d'attestation » (`demande_rh`) n'est offerte | RH (capacité absente) |
| DOC-14, DOC-30 | Police d'assurance introuvable ; contrat Pharmalliance déclaré « déjà rangé » sans proposer de choisir entre les deux | Résolution des fichiers Drive (T1) | T1 |
| MKT-07 | « Aucune visite enregistrée ces 30 jours » pour le délégué | Visites du semis hors de la fenêtre, ou lecture par un autre champ que l'auteur | T2 (à vérifier) |
| TR-MU-03 | Résumé juste, mais le mail n'est pas préparé (adresse du pharmacien responsable inconnue) | Le mail pourrait partir sur une carte avec un destinataire à compléter | P1 bis |
| TR-LM-04 | Les brochures hors catalogue sont retirées de la demande | Article absent du catalogue du semis | banc / matériel promo |

### Faible — formulation ou exigence du banc trop étroite

| Tâche | Constat | Correctif |
|---|---|---|
| DOC-31, DOC-33, ANN-04, ANN-17 | Refus justes (« n'a pas été trouvé », « ne vous est pas ouvert », « introuvable dans votre annuaire ») ; le motif attendu ne couvre pas ces tournures | élargir le `contient` (T1, T2) — pour un hors-secteur, « introuvable » ne confirme même pas l'existence de la fiche |
| TR-Q-03 | Réponse juste, sans lien vers l'écran | Q1 : accepter le nom du module, ou exiger le lien côté produit |
| TR-ER-02 | Une question (« pouvez-vous vérifier son nom ? ») avant de refuser un destinataire inexistant | Q1 : `questionsMax: 1` |
| **AN-04** | « Aucune tâche en retard » : **juste**, le semis n'en pose aucune | **corrigé** (Q1) : `contient` accepte « aucune » |
| **AN-ANNULER-03** | « aucune demande n'**aura été créée** » lu comme « a été créée » (faux « c'est fait ») ; l'assistant ne retire pas lui-même la carte non confirmée | **verdict corrigé** (Q1, `\b` dans `affirmeFait` + test) ; le retrait de la carte reste un défaut faible du produit |
