# watch — la app de Apple Watch

Primera versión: abre y dice **Hola**. Nada más, a propósito.

Lo que se está probando aquí no es el código —son 15 líneas de SwiftUI— sino
si una app sideloaded **llega a instalarse en el reloj**. Esa es la incógnita,
y sale más barato descubrirla con un "hola" que con una app entera encima.

## El montaje, y por qué no es lo que parece

Una app de Apple Watch **no se distribuye sola** fuera de la App Store. Va
dentro del bundle de una app de iPhone:

```
Hermes.ipa
└── Payload/
    └── Hermes.app              ← esto es lo que instala SideStore
        └── Watch/
            └── HermesWatch.app ← y esto es lo que tiene que llegar al reloj
```

SideStore instala **apps de iOS**. Quien pasa la app al reloj es la app Watch
del iPhone, después. Con apps sideloaded ese último salto a veces funciona y
a veces el reloj simplemente no la ofrece — no por el código, sino por el
canal de distribución.

> [!warning] El paso que puede fallar es el 8, no los anteriores
> Si el `.ipa` se instala en el iPhone y el reloj no ofrece la app, no es un
> error de compilación: es que el sideload no propagó al reloj. El contenedor
> muestra texto en pantalla justo para poder distinguir un caso del otro.

Dos reglas de Apple que el proyecto ya cumple y que rompen esto en silencio
si se tocan:

- el id del reloj tiene que ser el del iPhone **más un sufijo**
  (`com.samumontoya.hermes` → `com.samumontoya.hermes.watchkitapp`)
- el `Info.plist` del reloj necesita `WKApplication` y
  `WKCompanionAppBundleIdentifier`

## Estructura

| | |
|---|---|
| `project.yml` | La fuente de verdad. El `.xcodeproj` se genera y no se versiona. |
| `WatchApp/` | La app del reloj (SwiftUI). |
| `Container/` | La app de iPhone que la transporta. |
| `scripts/build-ipa.sh` | Compila y arma el `.ipa`. |

`project.pbxproj` es un formato denso, con IDs generados, imposible de revisar
en un diff y muy fácil de romper a mano. Por eso XcodeGen: se edita el YAML y
se regenera.

## Compilar

Requiere **Xcode** (las Command Line Tools solas no bastan) y `xcodegen`
(`brew install xcodegen`).

```bash
./scripts/build-ipa.sh
```

Sale sin firmar a propósito: **quien firma es SideStore**, ya en el iPhone y
con tu Apple ID — y esa firma es la que se renueva sola cada 7 días. Firmar en
la Mac exigiría un equipo de desarrollo y SideStore la reemplazaría igual.

El script verifica que la app del reloj quedó dentro del bundle antes de
empaquetar. Sin esa comprobación, un `.ipa` sin reloj dentro se instala en el
iPhone igual de bien y el fallo no se ve hasta el reloj.

## Después de compilar

1. Pasa `build/Hermes.ipa` al iPhone (AirDrop es lo más directo).
2. Ábrelo con SideStore → instala.
3. En el iPhone: app **Watch** → **Apps disponibles** → instalar Hermes.

La Mac ya no hace falta hasta el siguiente cambio de código.
