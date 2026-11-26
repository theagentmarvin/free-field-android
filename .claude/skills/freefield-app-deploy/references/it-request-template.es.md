# Solicitud a TI: nuestra app de terreno FreeField en las tablets de la empresa (español)

Completa cada `{{…}}` y borra lo que no aplique. Nada de esto es secreto. El agente escribe **dos piezas**: un correo corto (lo que la gente realmente lee) y el anexo técnico. No inventes direcciones, ids ni números: pregunta al usuario o deja el marcador. No cites precios.

## Pieza 1: correo de portada (máximo 15 líneas)

**Asunto:** Solicitud: instalar nuestra app de terreno FreeField en {{N_TABLETS}} tablets de la empresa

Hola {{CONTACTO_TI}},

Queremos usar la app de terreno de FreeField (una app Android de código abierto para incidencias de obra, planos y modelos 3D, que también funciona sin conexión) en {{N_TABLETS}} tablets de la empresa desde el {{FECHA_INICIO}}. La compilamos nosotros mismos, firmada con una llave propia, y se conecta a nuestro sitio FreeField `{{DIRECCION_DEL_SITIO}}`, que ya funciona en nuestro proyecto de Firebase. No se publica en ninguna tienda pública.

Necesitamos cuatro cosas de ustedes:
1. Permitir descargas por el proxy o firewall en el computador de compilación ({{COMPUTADOR_DE_COMPILACION}}) para la instalación única de herramientas y para cada compilación.
2. Una forma de instalar la app en las tablets: {{METODO_DE_INSTALACION}}.
3. Acceso de red desde las tablets a nuestro sitio y a los servicios de Google que usa.
4. Una ventana corta para publicar el sitio web de nuevo, para que publique el archivo que hace que el enlace de inicio de sesión abra la app.

Preguntas abiertas: {{PREGUNTAS_ABIERTAS}}. El detalle está en el anexo adjunto.

Gracias,
{{NOMBRE_SOLICITANTE}}, {{CARGO}}

## Pieza 2: anexo técnico

### 1. De qué se trata
- App: {{NOMBRE_DE_LA_APP}}, id de aplicación `{{APPLICATION_ID}}`, Android 8 o superior, tablets: {{MODELO_O_FLOTA}}.
- Se compila en un computador con Node.js 20, Java 21 y el SDK de Android, todo instalado en la carpeta del propio usuario (unos 6 GB, **sin permisos de administrador**). Se firma con una llave de la empresa guardada en el gestor de contraseñas corporativo.
- La app guarda sus datos de trabajo en la tablet y se sincroniza con nuestro proyecto de Firebase a través del mismo backend del sitio web (Authentication, Firestore, Storage).

### 2. Descargas permitidas en el computador de compilación (HTTPS)
- `github.com`, `objects.githubusercontent.com`: Java 21 (Eclipse Temurin) y nuestro repositorio.
- `dl.google.com`, `maven.google.com`, `dl-ssl.google.com`: SDK de Android y librerías.
- `repo.maven.apache.org`, `repo1.maven.org`, `plugins.gradle.org`, `services.gradle.org`, `downloads.gradle.org`: herramienta de compilación y librerías.
- `registry.npmjs.org`: paquetes JavaScript. `api.adoptium.net` si el proxy lo necesita.
- Solo para el inicio de sesión único en Firebase: `accounts.google.com`, `oauth2.googleapis.com`, `firebase.googleapis.com`.
- Por favor no bloqueen archivos `.apk`, `adb` ni la depuración USB en ese computador.

### 3. Instalación en las tablets (elijan una e indíquenos cuál)
- [ ] **Cable USB con depuración USB** para pocas tablets (la política debe permitir opciones de desarrollador).
- [ ] **Copia del archivo o enlace de descarga**: permitir "instalar desde esta fuente" al administrador de archivos o al navegador.
- [ ] **Nuestra herramienta de gestión de dispositivos (MDM)**: subir el `.apk` firmado como app privada (interna) y asignarla al grupo {{GRUPO_DE_TABLETS}}. Cada actualización usa el mismo id de aplicación y la misma llave de firma, con un número de versión mayor.
- [ ] **Una ficha privada en Google Play** para nuestra organización: subimos un `.aab`; necesitamos una cuenta de desarrollador de Google Play Console (pago único de inscripción, a definir quién lo paga) o acceso a la de la empresa. Google firma con su propia llave; les daremos esa huella para el archivo del sitio web.

### 4. Acceso de red de las tablets (HTTPS, puerto 443)
`{{DIRECCION_DEL_SITIO}}`, `{{ID_PROYECTO_FIREBASE}}.firebaseapp.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com`, `firebasestorage.googleapis.com`. Si hay inspección TLS, avísennos: puede romper estas conexiones.

### 5. Correo electrónico
Los enlaces de inicio de sesión los envía Firebase (`noreply@{{ID_PROYECTO_FIREBASE}}.firebaseapp.com`). Por favor aseguren que el filtro de correo y la protección de enlaces no los bloqueen ni los reescriban.

### 6. Ventana de publicación del sitio web
El sitio debe servir `https://{{DIRECCION_DEL_SITIO}}/.well-known/assetlinks.json` (un archivo público pequeño con el id de la app y la huella pública de la llave). Se agrega al repositorio del sitio y se publica con el despliegue normal. Ventana: {{VENTANA_DE_DESPLIEGUE}}.

### 7. Datos útiles para TI
- Código abierto, licencia MIT, sin SLA de soporte. La llave de firma pertenece a la empresa.
- Desinstalar la app o borrar una tablet elimina sus datos sin conexión y los cambios sin sincronizar. Por favor no lo hagan como solución rutinaria.
- Las actualizaciones se instalan sobre la versión anterior (mismo id de aplicación, misma llave).
- Opcional, solo si las compilaciones deben correr en GitHub y no en un portátil: minutos de GitHub Actions para un repositorio privado (unos {{MINUTOS_DE_COMPILACION}} minutos por compilación).
