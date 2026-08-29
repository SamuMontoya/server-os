# server-os — el fork de servidor

Fork de [hermes-os](https://github.com/ruloCode/hermes-os) adaptado para correr
**headless en un servidor Linux 24/7**, como cerebro central que después
consumirán otros clientes (dashboard, móvil, watch).

Upstream: `upstream-hermes` (solo lectura). El original no se toca.

---

## En una frase

Lo mismo que hermes-os, pero: corre en Linux con systemd, vectoriza local con
Ollama, apaga por configuración lo que un servidor no puede hacer, elige el
modelo según la tarea, y baja el consumo solo cuando el plan se agota.

---

## Diferencias con hermes-os

| Área | hermes-os | server-os |
|---|---|---|
| SO / arranque | macOS · launchd | Linux · systemd `--user` |
| Embeddings | OpenAI 1536 (de pago) | Ollama 768, local y gratis |
| Features | todas | 9 apagadas por configuración |
| Modelo | uno para todo | por rol + router dinámico |
| Consumo | sin control | modo bajo automático al 70% |
| Vault | dueño | solo-lectura (espejo de Supabase) |

---

## Máquina de referencia

Laptop reciclada: Intel i3-4005U (2 núcleos @1.6 GHz), 3.2 GB RAM, Ubuntu 26.04.
Da la talla porque **el trabajo pesado lo hace Anthropic** — el agente está
bloqueado esperando la red, no calculando. Lo único que pide memoria de verdad
es `next build`, y para eso se amplió el swap a ~8 GB.

---

## Embeddings locales (migración 025)

El servidor no tiene key de OpenAI, pero **comparte la base con el hermes-os de
la Mac**. Convertir el esquema a 768 dims habría roto la Mac, así que la
migración es **aditiva**: columnas `*_local vector(768)` y RPCs `*_local` al
lado de las de 1536, que quedan intactas.

`EMBEDDINGS_PROVIDER=ollama|openai|none` decide cuál usa este proceso.
`apps/agent/src/embeddings.ts` expone `EMB.col` y `EMB.rpc.*` para que los 7
consumidores no escriban a mano ni la columna ni la RPC.

> **Limitación real:** pgvector no compara vectores de distinta dimensión. Lo
> que escribe el servidor en 768 **no aparece** en la búsqueda semántica de la
> Mac, ni al revés. Comparten filas y metadatos, no índice.

---

## Feature flags

```
HERMES_DISABLED=estudio,juntas,ingles,voz,linear,agenda,vida,codegraph,gestos
```

Nada se borra: se apaga. Si mañana el watch pide juntas, el código está.

Tres capas: lista canónica en `packages/shared/src/features.ts`, un middleware
por prefijo en `index.ts` (404 con motivo) y filtrado del catálogo de tools.
Con la config del servidor son **10 tools en vez de 27** — y cada tool viaja en
cada turno.

El dashboard usa flags **de build** aparte (`NEXT_PUBLIC_FEATURE_*`), porque
webpack no puede eliminar una rama que se decide en runtime. Cambiarlos exige
recompilar; los del agente se leen en caliente. Deben ir coherentes.

---

## Orquestación de modelos

**Por rol** (`agent/models.ts`) — el criterio no es "el más barato" sino costo
por *tarea completada*: un modelo flojo que necesita tres intentos sale más
caro.

```
console/run  opus/high    videoEdit      opus/xhigh
contentKit   sonnet/high  meetingIngest  sonnet/medium
analyst · variants · liveCopilot · liveCoach   haiku
```

**Router dinámico** (`agent/router.ts`) — clasifica cada turno nuevo:
`light=haiku · standard=sonnet · deep=opus`. La clasificación es **local, cero
tokens**: un clasificador LLM costaría un turno por turno.

> **El nivel se fija por sesión.** El caché de prompt es por modelo, así que
> cambiarlo a mitad de hilo tira el prefijo cacheado y re-cachear cuesta más
> que lo ahorrado. Se enruta al ABRIR, nunca dentro.

**Subagentes** — un `scout` en haiku, solo lectura. Corre en su propio contexto
y devuelve solo su conclusión: saca trabajo del hilo principal sin tocar su
caché.

**Escalado** — si el turno falla y hay nivel arriba, reintenta UNA vez arriba y
la sesión queda ahí.

Apagar: `HERMES_ROUTER=off`, `HERMES_SUBAGENTS=off`.

---

## Modo de bajo consumo

Se activa al pasar `HERMES_LOW_POWER_AT` (70%) de la ventana de 5 h, o a mano
con `HERMES_LOW_POWER=1`.

| | Normal | Bajo |
|---|---|---|
| Modelo | opus/high | sonnet/low |
| Turnos | 40 | 15 |
| Subagentes | opcional | forzados |
| Precarga de contexto | 5+8 @300 | 2+3 @160 |

La última es la que más pesa: el prompt precargaba hasta ~975 tokens de
memorias y búsquedas **en cada turno, se usaran o no**. En modo bajo son ~200 y
el agente amplía con `search_knowledge` si lo necesita — se paga contexto
pedido, no especulativo.

Solo **restringe**: nunca encarece un turno que el router ya clasificó barato.
Y **falla hacia normal**: si no puede leer el uso, degradar a ciegas es peor.

El % sale de `/api/oauth/usage` con la credencial del **propio CLI** — no hay
que mantener ningún token aparte.

---

## Operación

```bash
./scripts/install-linux.sh          # build + systemd + arranque automático
./scripts/install-linux.sh --no-build

systemctl --user restart hermes-agent
journalctl --user -u hermes-agent -f
curl -s localhost:8650/health
```

El arranque imprime el estado completo — si algo responde raro, empieza ahí:

```
apagadas: estudio, juntas, ...
embeddings: ollama (768d → embedding_local)
modelos: console=opus/high run=opus/high analyst=haiku
consumo: normal (sesión 16%)
```

### Actualizar

```bash
git pull && pnpm install --frozen-lockfile && \
  NODE_OPTIONS="--max-old-space-size=1536" pnpm build && \
  systemctl --user restart hermes-agent hermes-web
```

Sin cambios en `apps/web` basta reiniciar el agente.

---

## Trampas conocidas

**El `.env` no está en el repo.** Al copiarlo desde otra máquina, revisa
`HERMES_CODE_ROOT`, `MACHINE_NAME` (PK de presencia: dos agentes con el mismo
nombre se pisan) y `NEXT_PUBLIC_HERMES_URL`.

**`HERMES_MODEL` global aplana la política por rol.** Déjalo vacío y usa los
overrides por rol (`HERMES_MODEL_CONSOLE=sonnet:low`).

**Un proceso que lee una variable que nadie cargó.** Pasó tres veces en este
fork: `features.ts` evaluándose antes que dotenv, `models.ts` sin importar
`env.js`, y el prebuild de MediaPipe corriendo como proceso aparte. Si algo
"no aplica la configuración", sospecha de esto primero.

**`crypto.randomUUID` solo existe en contextos seguros** (HTTPS o localhost).
Invisible en desarrollo, fatal al abrir el dashboard desde otra máquina. De ahí
`lib/uuid.ts`.

**CORS y Tailscale.** La malla asigna en `100.64.0.0/10` (CGNAT), que no es
ningún rango privado clásico. El allowlist de `index.ts` ya lo incluye; si
agregas otra red, ahí es.

**El build necesita swap.** Con 3.2 GB de RAM, `next build` no entra sin él.
El instalador aborta antes de intentarlo en vez de morir a mitad.
