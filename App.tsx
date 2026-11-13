import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Image,
  SafeAreaView,
  StatusBar,
  Alert,
  ActivityIndicator,
  Platform,
  Linking,
  useWindowDimensions,
} from 'react-native';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  validatePassword,
  sendPasswordResetEmail,
  type PasswordPolicy,
} from 'firebase/auth';
import { auth, db } from './firebaseConfig';
import { WebView } from 'react-native-webview';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
  where,
} from 'firebase/firestore';

// Opciones rápidas para indicar cuándo se perdió / se vio la mascota
const OPCIONES_CUANDO = [
  { id: 'ahora', label: 'Ahora', min: 0 },
  { id: '1h', label: 'Hace 1 h', min: 60 },
  { id: '3h', label: 'Hace 3 h', min: 180 },
  { id: 'ayer', label: 'Ayer', min: 1440 },
  { id: '2d', label: 'Hace 2 días', min: 2880 },
];

const tiempoRelativo = (iso?: string): string => {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 2) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
};

const fechaCompleta = (iso?: string): string =>
  iso
    ? new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

// Distancia en km entre dos coordenadas (fórmula de Haversine)
const distanciaKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const formatoDistancia = (km: number): string =>
  km < 0.1 ? 'menos de 100 m' : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

const razaVisible = (raza: string): string => {
  const texto = raza.trim();
  return !texto || /^(raza\s+)?desconocid[ao]$/i.test(texto) ? 'Raza desconocida' : texto;
};

// Confirmación con dos botones (Alert.alert con botones tampoco funciona en la web)
const confirmar = (titulo: string, mensaje: string): Promise<boolean> =>
  new Promise((resolve) => {
    if (Platform.OS === 'web') {
      resolve(window.confirm(`${titulo}\n\n${mensaje}`));
      return;
    }
    Alert.alert(
      titulo,
      mensaje,
      [
        { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Sí, confirmar', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });

// Muestra HTML (los mapas): iframe en la web, WebView en el teléfono.
// onMensaje recibe lo que la página envía (por ejemplo, el punto que se tocó en el mapa).
const VistaHtml = ({
  html,
  scrollEnabled = true,
  onMensaje,
}: {
  html: string;
  scrollEnabled?: boolean;
  onMensaje?: (data: string) => void;
}) => {
  const marcoRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !onMensaje) return;
    const escuchar = (e: MessageEvent) => {
      if (e.source !== marcoRef.current?.contentWindow) return;
      if (typeof e.data === 'string') onMensaje(e.data);
    };
    window.addEventListener('message', escuchar);
    return () => window.removeEventListener('message', escuchar);
  }, [onMensaje]);

  if (Platform.OS === 'web') {
    return React.createElement('iframe' as any, {
      srcDoc: html,
      ref: marcoRef,
      title: 'Mapa de PetFind',
      style: { border: 'none', width: '100%', height: '100%' },
    });
  }
  return (
    <WebView
      style={{ flex: 1 }}
      originWhitelist={['*']}
      scrollEnabled={scrollEnabled}
      nestedScrollEnabled
      source={{ html }}
      onMessage={(e) => onMensaje?.(e.nativeEvent.data)}
    />
  );
};

// Mapa para marcar el punto del reporte: se toca el mapa y el punto se puede arrastrar
const generarSelectorMapaHtml = (
  centro: { lat: number; lng: number },
  punto: { lat: number; lng: number } | null
): string => `
  <!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>html, body, #mapa { height: 100%; margin: 0; padding: 0; }</style>
    </head>
    <body>
      <div id="mapa"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const mapa = L.map('mapa').setView([${centro.lat}, ${centro.lng}], ${punto ? 16 : 14});
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(mapa);

        let marcador = null;
        function enviar(lat, lng) {
          const msg = JSON.stringify({ tipo: 'punto', lat: lat, lng: lng });
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
          else window.parent.postMessage(msg, '*');
        }
        function poner(lat, lng, avisar) {
          if (marcador) {
            marcador.setLatLng([lat, lng]);
          } else {
            marcador = L.marker([lat, lng], { draggable: true }).addTo(mapa);
            marcador.on('dragend', function () {
              const p = marcador.getLatLng();
              enviar(p.lat, p.lng);
            });
          }
          if (avisar) enviar(lat, lng);
        }
        ${punto ? `poner(${punto.lat}, ${punto.lng}, false);` : ''}
        mapa.on('click', function (e) { poner(e.latlng.lat, e.latlng.lng, true); });
      </script>
    </body>
  </html>
`;

// Fila de información de la pantalla de detalle
// Icono vectorial (Ionicons por defecto, MaterialCommunityIcons con mci)
const Ico = ({ n, s = 16, c = '#555', mci = false }: { n: string; s?: number; c?: string; mci?: boolean }) =>
  mci ? (
    <MaterialCommunityIcons name={n as any} size={s} color={c} />
  ) : (
    <Ionicons name={n as any} size={s} color={c} />
  );

// Icono + texto en una misma fila
const IcoTexto = ({
  n,
  mci,
  s = 14,
  c = '#555',
  textoStyle,
  estilo,
  centrado = false,
  children,
}: {
  n: string;
  mci?: boolean;
  s?: number;
  c?: string;
  textoStyle?: any;
  estilo?: any;
  centrado?: boolean;
  children?: React.ReactNode;
}) => (
  <View
    style={[
      { flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: centrado ? 'center' : 'flex-start' },
      estilo,
    ]}
  >
    <Ico n={n} mci={mci} s={s} c={c} />
    <Text style={[textoStyle, { flexShrink: 1 }]}>{children}</Text>
  </View>
);

// Pantalla vacía con icono, mensaje y un botón de acción
const EstadoVacio = ({
  icono,
  mci,
  titulo,
  texto,
  boton,
  onBoton,
}: {
  icono: string;
  mci?: boolean;
  titulo: string;
  texto: string;
  boton: string;
  onBoton: () => void;
}) => (
  <View style={{ alignItems: 'center', paddingVertical: 36, paddingHorizontal: 20 }}>
    <View
      style={{
        width: 76,
        height: 76,
        borderRadius: 38,
        backgroundColor: '#e6f8f1',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 14,
      }}
    >
      <Ico n={icono} mci={mci} s={38} c="#007d54" />
    </View>
    <Text style={{ fontSize: 17, fontWeight: 'bold', color: '#222', marginBottom: 6, textAlign: 'center' }}>{titulo}</Text>
    <Text style={{ fontSize: 14, color: '#555', textAlign: 'center', maxWidth: 320, lineHeight: 20, marginBottom: 16 }}>
      {texto}
    </Text>
    <TouchableOpacity
      onPress={onBoton}
      style={{ backgroundColor: '#007d54', paddingHorizontal: 20, paddingVertical: 11, borderRadius: 22 }}
    >
      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 14 }}>{boton}</Text>
    </TouchableOpacity>
  </View>
);

// Tarjeta gris que se muestra mientras cargan los reportes
const TarjetaEsqueleto = ({ vertical }: { vertical: boolean }) => {
  const gris = '#e6e9e8';
  const barra = (ancho: any, alto: number, margen = 6) => (
    <View style={{ width: ancho, height: alto, borderRadius: 4, backgroundColor: gris, marginBottom: margen }} />
  );
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#eee' }}>
      {vertical ? (
        <>
          <View style={{ width: '100%', aspectRatio: 1.6, backgroundColor: gris }} />
          <View style={{ padding: 12 }}>
            {barra('55%', 16, 8)}
            {barra('35%', 12)}
            {barra('70%', 10, 0)}
          </View>
        </>
      ) : (
        <View style={{ flexDirection: 'row', padding: 10 }}>
          <View style={{ width: 54, height: 54, borderRadius: 8, backgroundColor: gris, marginRight: 10 }} />
          <View style={{ flex: 1, justifyContent: 'center' }}>
            {barra('50%', 14, 8)}
            {barra('30%', 11)}
            {barra('65%', 10, 0)}
          </View>
        </View>
      )}
    </View>
  );
};

const FilaDetalle = ({ icono, mci, titulo, valor }: { icono: string; mci?: boolean; titulo: string; valor: string }) => (
  <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 8 }}>
    <View style={{ width: 24, alignItems: 'center', paddingTop: 1 }}>
      <Ico n={icono} mci={mci} s={20} c="#555" />
    </View>
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 11, color: '#6b6b6b', fontWeight: '700' }}>{titulo}</Text>
      <Text style={{ fontSize: 14, color: '#222' }}>{valor}</Text>
    </View>
  </View>
);

// Mini mapa con un solo punto (Leaflet + OpenStreetMap)
const generarMiniMapaHtml = (lat: number, lng: number, color: string): string => `
  <!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>html, body, #mapa { height: 100%; margin: 0; padding: 0; }</style>
    </head>
    <body>
      <div id="mapa"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const mapa = L.map('mapa').setView([${lat}, ${lng}], 15);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(mapa);
        L.circleMarker([${lat}, ${lng}], {
          radius: 11, fillColor: '${color}', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(mapa);
      </script>
    </body>
  </html>
`;

// Convierte un punto del mapa en un nombre de zona (calle, colonia, ciudad)
const nombreDeZona = async (lat: number, lng: number): Promise<string> => {
  try {
    if (Platform.OS !== 'web') {
      const [d] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      const texto = [d?.street, d?.district ?? d?.subregion, d?.city].filter(Boolean).join(', ');
      if (texto) return texto;
    } else {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=es&lat=${lat}&lon=${lng}`
      );
      const j = await r.json();
      const a = j.address ?? {};
      const texto = [a.road, a.suburb ?? a.neighbourhood ?? a.quarter, a.city ?? a.town ?? a.municipality]
        .filter(Boolean)
        .join(', ');
      if (texto) return texto;
    }
  } catch {}
  return '';
};

// Devuelve la zona solo si es un texto real (oculta los textos genéricos de reportes viejos)
const zonaUtil = (u?: string): string => {
  const t = (u ?? '').trim();
  if (!t || t === 'Ubicación marcada en el mapa' || t === 'Usar mi ubicación') return '';
  return t;
};

// Alert.alert no muestra nada en la versión web, así que usamos window.alert allí
const avisar = (titulo: string, mensaje: string) => {
  if (Platform.OS === 'web') {
    window.alert(`${titulo}\n\n${mensaje}`);
  } else {
    Alert.alert(titulo, mensaje);
  }
};

const PRIMARY_COLOR = '#00c280';
const PRIMARY_DARK = '#007d54';

// URL del servidor del escáner (backend en Vercel)
const ESCANEO_URL = 'https://petfind-backend.vercel.app/api/escanear';
// Servidor que avisa a otros usuarios cuando se publica una mascota parecida a la suya
const NOTIFICAR_URL = 'https://petfind-backend.vercel.app/api/notificar';
// Servidor que cierra los dos reportes cuando se confirma que la mascota ya regresó a casa
const REENCUENTRO_URL = 'https://petfind-backend.vercel.app/api/reencuentro';

// Correo del equipo para ejercer derechos sobre los datos (escríbelo aquí; si queda vacío no se muestra)
const CORREO_PRIVACIDAD = 'petfind.contacto@gmail.com';

const AVISO_PRIVACIDAD: { t: string; x: string }[] = [
  {
    t: 'Responsable',
    x: 'PetFind es un proyecto académico desarrollado por su equipo de estudiantes. Este aviso se elabora con base en la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.',
  },
  {
    t: 'Datos que recabamos',
    x: 'Correo electrónico y contraseña de tu cuenta (la contraseña la administra Firebase Authentication y el equipo no puede verla). En cada reporte: nombre y descripción de la mascota, fotografía, ubicación (coordenadas) y tu nombre y teléfono de contacto.',
  },
  {
    t: 'Para qué los usamos',
    x: 'Crear tu cuenta, publicar y mostrar reportes en el mapa, permitir que otras personas te contacten, comparar fotografías con inteligencia artificial y enviarte avisos de posibles coincidencias.',
  },
  {
    t: 'Quién puede ver tus datos',
    x: 'Los reportes, incluidos el nombre y el teléfono de contacto que escribas, son visibles para las personas con sesión iniciada en la app. Tu correo y tu contraseña no se muestran a otros usuarios. No vendemos tus datos.',
  },
  {
    t: 'Servicios de terceros',
    x: 'Usamos Firebase (Google) para las cuentas y la base de datos, Vercel para el servidor y un servicio de inteligencia artificial de Google (Gemini), al que se envían las fotografías únicamente para compararlas.',
  },
  {
    t: 'Cuánto tiempo los conservamos',
    x: 'Los reportes resueltos se borran a los 30 días. Los reportes activos pasan a "vencidos" a los 90 días y dejan de mostrarse. Los avisos se borran a los 30 días.',
  },
  {
    t: 'Tus derechos',
    x: 'Puedes editar o borrar tus reportes desde la app. Para acceder a tus datos, corregirlos, cancelarlos u oponerte a su uso, o para eliminar tu cuenta, contacta al equipo' + (CORREO_PRIVACIDAD ? ` en ${CORREO_PRIVACIDAD}.` : '.'),
  },
  { t: 'Cambios', x: 'Si este aviso cambia, lo publicaremos en la app.' },
];

// Pasos de la guía que se muestra la primera vez que alguien entra
const PASOS_GUIA: { icono: string; mci?: boolean; titulo: string; texto: string }[] = [
  {
    icono: 'paw',
    mci: true,
    titulo: 'Bienvenido a PetFind',
    texto: 'Aquí se reúnen los reportes de mascotas perdidas y encontradas cerca de ti para ayudarlas a volver a casa.',
  },
  {
    icono: 'add-circle-outline',
    titulo: 'Publica un reporte',
    texto: 'Toca Reportar, agrega una foto, marca en el mapa dónde estaba la mascota y deja tu contacto. Aparece al instante.',
  },
  {
    icono: 'camera-outline',
    titulo: 'Escanea una mascota',
    texto: 'Si viste un animal en la calle, toma una foto con Escanear. La inteligencia artificial buscará posibles coincidencias.',
  },
  {
    icono: 'call-outline',
    titulo: 'Contacta y cierra el caso',
    texto: 'Desde el detalle puedes llamar o escribir por WhatsApp. Cuando la mascota regrese, marca tu reporte como resuelto.',
  },
  {
    icono: 'notifications-outline',
    titulo: 'Recibe avisos',
    texto: 'Si alguien publica una mascota parecida a la tuya, te lo mostramos en la campana de la parte superior.',
  },
];

// Interfaces de TypeScript
interface ReporteMascota {
  id: string;
  nombre: string;
  raza: string;
  tipo: 'Perdida' | 'Encontrada';
  especie: 'Perro' | 'Gato' | 'Otro';
  especieOtro?: string; // Si especie es 'Otro', aquí va cuál (Ej. Conejo)
  contactoNombre?: string; // Quién reporta
  telefono?: string; // Teléfono / WhatsApp (solo dígitos)
  fechaEvento?: string; // Cuándo se perdió o se vio (fecha ISO)
  recompensa?: string; // Vacío si no hay recompensa
  estado?: 'Activo' | 'Reunida' | 'Vencida'; // 'Reunida' = resuelto, 'Vencida' = sin movimiento por mucho tiempo
  autorId?: string | null; // Quién creó el reporte
  ubicacion: string;
  descripcion: string;
  foto: string;
  latitud: number;
  longitud: number;
}

interface Notificacion {
  id: string;
  tipo: string; // 'coincidencia' o 'cierre'
  tuReporteId: string;
  tuReporteNombre: string;
  reporteNuevoId: string;
  reporteNuevoNombre: string;
  reporteNuevoTipo: string;
  similitud: number;
  motivo: string;
  leida: boolean;
  creadoMs: number;
}

interface Coincidencia {
  id: string;
  similitud: number; // 0 a 100
  motivo: string;
}

// Requisitos obtenidos de la política real del proyecto, sin fijar reglas locales distintas.
const requisitosDePassword = (politica: PasswordPolicy, incluirMaximo = true): string[] => {
  const r = politica.customStrengthOptions;
  const lista: string[] = [];
  if (r.minPasswordLength !== undefined) lista.push(`Al menos ${r.minPasswordLength} caracteres`);
  if (incluirMaximo && r.maxPasswordLength !== undefined) lista.push(`Como máximo ${r.maxPasswordLength} caracteres`);
  if (r.containsLowercaseLetter) lista.push('Una letra minúscula');
  if (r.containsUppercaseLetter) lista.push('Una letra mayúscula');
  if (r.containsNumericCharacter) lista.push('Un número');
  if (r.containsNonAlphanumericCharacter) lista.push(`Un símbolo de esta lista: ${politica.allowedNonAlphanumericCharacters}`);
  return lista;
};

  // Genera el HTML del mapa con Leaflet + OpenStreetMap (gratis, sin API key)
const generarMapaReportesHtml = (
  reportes: ReporteMascota[],
  miUbicacion: { lat: number; lng: number } | null
): string => {
    const centro =
      miUbicacion ??
      (reportes[0]
        ? { lat: reportes[0].latitud, lng: reportes[0].longitud }
        : { lat: 25.6866, lng: -100.3161 });
    const puntos = reportes.map((r) => ({
      id: r.id,
      lat: r.latitud,
      lng: r.longitud,
      color: r.tipo === 'Perdida' ? '#e53935' : PRIMARY_COLOR,
      titulo: r.nombre,
      detalle: `${r.especie === 'Otro' && r.especieOtro ? r.especieOtro + ' · ' : ''}${r.raza} · ${r.ubicacion}${r.fechaEvento ? ' · ' + tiempoRelativo(r.fechaEvento) : ''}`,
    }));

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
          <style>
            html, body, #mapa { height: 100%; margin: 0; padding: 0; }
            .leyenda-mapa { background: #fff; padding: 8px 10px; border-radius: 8px; font: 13px/20px sans-serif; color: #333; box-shadow: 0 1px 5px #0003; }
            .ver-reporte { display: block; margin-top: 10px; min-height: 44px; padding: 8px 16px; border: 0; border-radius: 7px; background: #007d54; color: #fff; font: 600 14px sans-serif; cursor: pointer; }
            .ver-reporte:focus-visible { outline: 3px solid #111; outline-offset: 3px; }
            .leyenda-mapa span { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; }
          </style>
        </head>
        <body>
          <div id="mapa"></div>
          <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
          <script>
            const mapa = L.map('mapa').setView([${centro.lat}, ${centro.lng}], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
              attribution: '&copy; OpenStreetMap contributors'
            }).addTo(mapa);

            const puntos = ${JSON.stringify(puntos).replace(/</g, '\\u003c')};
            const yo = ${JSON.stringify(miUbicacion)};
            // La ubicación se mantiene debajo de los reportes y no intercepta sus pulsaciones.
            mapa.createPane('ubicacion');
            mapa.getPane('ubicacion').style.zIndex = '350';
            mapa.getPane('ubicacion').style.pointerEvents = 'none';
            if (yo) {
              L.circleMarker([yo.lat, yo.lng], {
                pane: 'ubicacion', radius: 18,
                fillColor: '#1e88e5', color: '#1e88e5',
                weight: 3, fillOpacity: 0.15, interactive: false
              }).addTo(mapa);
              L.circleMarker([yo.lat, yo.lng], {
                pane: 'ubicacion', radius: 6,
                fillColor: '#1e88e5', color: '#fff',
                weight: 2, fillOpacity: 1, interactive: false
              }).addTo(mapa);
            }
            puntos.forEach(function (p) {
              const contenido = document.createElement('div');
              const titulo = document.createElement('strong');
              titulo.textContent = p.titulo;
              const detalle = document.createElement('div');
              detalle.textContent = p.detalle;
              contenido.appendChild(titulo);
              contenido.appendChild(detalle);
              const boton = document.createElement('button');
              boton.type = 'button';
              boton.className = 'ver-reporte';
              boton.textContent = 'Ver reporte';
              boton.setAttribute('aria-label', 'Ver reporte de ' + p.titulo);
              boton.addEventListener('click', function () {
                const mensaje = JSON.stringify({ tipo: 'abrir-reporte', id: p.id });
                if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(mensaje);
                else window.parent.postMessage(mensaje, '*');
              });
              contenido.appendChild(boton);
              L.circleMarker([p.lat, p.lng], {
                radius: 10, fillColor: p.color, color: '#fff',
                weight: 2, fillOpacity: 1
              }).addTo(mapa).bindPopup(contenido);
            });
            // Encuadrar todos los reportes, aunque alguno esté lejos del centro inicial.
            const limites = puntos.map(function (p) { return [p.lat, p.lng]; });
            if (yo) limites.push([yo.lat, yo.lng]);
            if (limites.length) mapa.fitBounds(limites, { padding: [32, 32], maxZoom: 16 });

            const leyenda = L.control({ position: 'bottomleft' });
            leyenda.onAdd = function () {
              const caja = L.DomUtil.create('div', 'leyenda-mapa');
              [['#e53935', 'Perdida'], ['${PRIMARY_COLOR}', 'Encontrada'], ['#1e88e5', 'Tu ubicación']].forEach(function (dato) {
                const fila = document.createElement('div');
                const color = document.createElement('span');
                color.style.backgroundColor = dato[0];
                fila.appendChild(color);
                fila.appendChild(document.createTextNode(dato[1]));
                caja.appendChild(fila);
              });
              L.DomEvent.disableClickPropagation(caja);
              return caja;
            };
            leyenda.addTo(mapa);
          </script>
        </body>
      </html>
    `;
};


export default function App() {
  // Estado de Autenticación
  const [sesionIniciada, setSesionIniciada] = useState<boolean>(false);
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [mostrarPassword, setMostrarPassword] = useState(false);
  const [politicaPassword, setPoliticaPassword] = useState<PasswordPolicy | null>(null);
  const [errorPolitica, setErrorPolitica] = useState(false);
  const [recuperandoPassword, setRecuperandoPassword] = useState(false);
  const recuperacionEnCurso = useRef(false);
  const [modoRegistro, setModoRegistro] = useState<boolean>(false);
  const [cargandoAuth, setCargandoAuth] = useState<boolean>(false);

  useEffect(() => {
    if (!modoRegistro) return;
    let activo = true;
    // La cadena vacía permite consultar la política antes de que se escriba la contraseña.
    validatePassword(auth, '').then((resultado) => {
      if (!activo) return;
      setPoliticaPassword(resultado.passwordPolicy);
      setErrorPolitica(false);
    }).catch(() => {
      if (!activo) return;
      setErrorPolitica(true);
    });
    return () => { activo = false; };
  }, [modoRegistro]);

  // Estado de reportes de mascotas
  const [reportes, setReportes] = useState<ReporteMascota[]>([]);
  const [cargandoReportes, setCargandoReportes] = useState<boolean>(true);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [guiaVisible, setGuiaVisible] = useState<boolean>(false);
  const [avisoBorradorVisible, setAvisoBorradorVisible] = useState(false);
  useEffect(() => {
    if (!avisoBorradorVisible) return;
    const temporizador = setTimeout(() => setAvisoBorradorVisible(false), 5000);
    return () => clearTimeout(temporizador);
  }, [avisoBorradorVisible]);
  const [pasoGuia, setPasoGuia] = useState<number>(0);
  const [notificaciones, setNotificaciones] = useState<Notificacion[]>([]);
  const [notifVisible, setNotifVisible] = useState<boolean>(false);
  const [perfilVisible, setPerfilVisible] = useState(false);
  const [pestanaPerfil, setPestanaPerfil] = useState<'activos' | 'resueltos' | 'vencidos'>('activos');
  const uidPerfil = auth.currentUser?.uid;
  const misReportes = uidPerfil ? reportes.filter((r) => r.autorId === uidPerfil) : [];
  const gruposPerfil = {
    activos: misReportes.filter((r) => r.estado !== 'Reunida' && r.estado !== 'Vencida'),
    resueltos: misReportes.filter((r) => r.estado === 'Reunida'),
    vencidos: misReportes.filter((r) => r.estado === 'Vencida'),
  };
  const [privacidadVisible, setPrivacidadVisible] = useState<boolean>(false);
  const [aceptaPrivacidad, setAceptaPrivacidad] = useState<boolean>(false);

  // Estados de filtros del dashboard
  const [filtroEstado, setFiltroEstado] = useState<'Todos' | 'Perdida' | 'Encontrada'>('Todos');
  const [filtroEspecie, setFiltroEspecie] = useState<'Todos' | 'Perro' | 'Gato' | 'Otro'>('Todos');
  const [busqueda, setBusqueda] = useState<string>('');
  // Estadísticas reales: se calculan con los reportes guardados
  const reportesActivos = reportes.filter((r) => r.estado !== 'Reunida' && r.estado !== 'Vencida');
  const mascotasReunidas = reportes.filter((r) => r.estado === 'Reunida').length;
  const [vistaActual, setVistaActual] = useState<'lista' | 'mapa'>('lista');
  const [mostrarFiltros, setMostrarFiltros] = useState<boolean>(false);
  const [orden, setOrden] = useState<'recientes' | 'cercanos'>('recientes');

  // Estados para el formulario de nuevo reporte
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [nombre, setNombre] = useState<string>('');
  const [raza, setRaza] = useState<string>('');
  const [tipo, setTipo] = useState<'Perdida' | 'Encontrada'>('Perdida');
  const [especie, setEspecie] = useState<'Perro' | 'Gato' | 'Otro'>('Perro');
  const [especieOtro, setEspecieOtro] = useState<string>('');
  const [modalEspecieVisible, setModalEspecieVisible] = useState<boolean>(false);
  const [especieTemporal, setEspecieTemporal] = useState<string>('');
  const [contactoNombre, setContactoNombre] = useState<string>('');
  const [telefono, setTelefono] = useState<string>('');
  const [opcionCuando, setOpcionCuando] = useState<string>('ahora');
  const [hayRecompensa, setHayRecompensa] = useState<boolean>(false);
  const [recompensaTexto, setRecompensaTexto] = useState<string>('');
  const [ubicacion, setUbicacion] = useState<string>('');
  const [descripcion, setDescripcion] = useState<string>('');

  // Estados de la pantalla de detalle
  const [detalleVisible, setDetalleVisible] = useState<boolean>(false);
  const [mascotaDetalle, setMascotaDetalle] = useState<ReporteMascota | null>(null);

  // Estados del escáner y de la foto del reporte
  const [escaneando, setEscaneando] = useState<boolean>(false);
  const [coincidencias, setCoincidencias] = useState<Coincidencia[]>([]);
  const [resultadosVisible, setResultadosVisible] = useState<boolean>(false);
  const [comparados, setComparados] = useState<number | null>(null);
  const [estadoImagenEscaner, setEstadoImagenEscaner] = useState<'mascota' | 'sin_mascota' | 'no_clara' | null>(null);
  const [fotoLocal, setFotoLocal] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState<boolean>(false);

  // Estados de geolocalización
  const [coordsReporte, setCoordsReporte] = useState<{ lat: number; lng: number } | null>(null);
  const [selectorHtml, setSelectorHtml] = useState(() =>
    generarSelectorMapaHtml({ lat: 25.6866, lng: -100.3161 }, null)
  );
  const [miUbicacion, setMiUbicacion] = useState<{ lat: number; lng: number } | null>(null);
  const [obteniendoUbicacion, setObteniendoUbicacion] = useState<boolean>(false);

  const sinLeer = notificaciones.filter((x) => !x.leida).length;
  const pasoActual = PASOS_GUIA[pasoGuia] ?? PASOS_GUIA[0];
  const esUltimoPaso = pasoGuia >= PASOS_GUIA.length - 1;

  // Escucha en tiempo real los reportes guardados en Firestore
  useEffect(() => {
    if (!sesionIniciada) return;
    let activa = true;
    const q = query(collection(db, 'reportes'), orderBy('creado', 'desc'));
    const cancelar = onSnapshot(
      q,
      (snapshot) => {
        if (!activa) return;
        const lista: ReporteMascota[] = snapshot.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: d.id,
            nombre: x.nombre ?? '',
            raza: x.raza ?? 'Sin especificar',
            tipo: x.tipo ?? 'Perdida',
            especie: x.especie ?? 'Otro',
            especieOtro: x.especieOtro ?? '',
            contactoNombre: x.contactoNombre ?? '',
            telefono: x.telefono ?? '',
            fechaEvento: x.fechaEvento ?? '',
            recompensa: x.recompensa ?? '',
            estado: x.estado ?? 'Activo',
            autorId: x.autorId ?? null,
            ubicacion: x.ubicacion ?? '',
            descripcion: x.descripcion ?? '',
            foto: x.foto ?? '',
            latitud: x.latitud ?? 25.6866,
            longitud: x.longitud ?? -100.3161,
          };
        });
        setReportes(lista);
        setCargandoReportes(false);
      },
      () => {
        if (!activa) return;
        setCargandoReportes(false);
        avisar('Error', 'No se pudieron cargar los reportes. Revisa tu conexión y las reglas de Firestore.');
      }
    );
    return () => {
      activa = false;
      cancelar();
    };
  }, [sesionIniciada]);

  // Guía de primer uso: se muestra una sola vez por usuario
  useEffect(() => {
    if (!sesionIniciada) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    AsyncStorage.getItem(`petfind_guia_v1_${uid}`)
      .then((visto) => {
        if (!visto) {
          setPasoGuia(0);
          setGuiaVisible(true);
        }
      })
      .catch(() => {});
  }, [sesionIniciada]);

  const cerrarGuia = () => {
    setGuiaVisible(false);
    const uid = auth.currentUser?.uid;
    if (uid) AsyncStorage.setItem(`petfind_guia_v1_${uid}`, '1').catch(() => {});
  };

  // Avisos en tiempo real: coincidencias que el servidor detectó para tus reportes
  useEffect(() => {
    if (!sesionIniciada) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    let primera = true;
    let activa = true;
    const cancelar = onSnapshot(
      query(collection(db, 'notificaciones'), where('paraUid', '==', uid)),
      (snap) => {
        if (!activa) return;
        const lista: Notificacion[] = snap.docs
          .map((d) => {
            const x = d.data() as any;
            return {
              id: d.id,
              tipo: x.tipo ?? 'coincidencia',
              tuReporteId: x.tuReporteId ?? '',
              tuReporteNombre: x.tuReporteNombre ?? '',
              reporteNuevoId: x.reporteNuevoId ?? '',
              reporteNuevoNombre: x.reporteNuevoNombre ?? '',
              reporteNuevoTipo: x.reporteNuevoTipo ?? '',
              similitud: Number(x.similitud) || 0,
              motivo: x.motivo ?? '',
              leida: !!x.leida,
              creadoMs: x.creado?.toMillis ? x.creado.toMillis() : 0,
            };
          })
          .sort((a, b) => b.creadoMs - a.creadoMs);
        setNotificaciones(lista);
        // Si llega un aviso nuevo mientras usas la app, te lo muestra de inmediato
        if (!primera) {
          snap.docChanges().forEach((c) => {
            const x = c.doc.data() as any;
            if (c.type === 'added' && !x.leida) {
              if (x.tipo === 'cierre') {
                avisar('Tu reporte se cerró', x.motivo || 'Tu reporte se marcó como resuelto.');
              } else {
                avisar(
                  '¡Posible coincidencia!',
                  `Alguien publicó una mascota parecida a ${x.tuReporteNombre || 'la tuya'}. Revísalo en la campana de avisos.`
                );
              }
            }
          });
        }
        primera = false;
      },
      () => {}
    );
    return () => {
      activa = false;
      cancelar();
    };
  }, [sesionIniciada]);

  // ¿Mi reporte todavía está activo? (para mostrar el botón de confirmar)
  const reporteEstaActivo = (id: string) => {
    const r = reportes.find((x) => x.id === id);
    return !!r && r.estado !== 'Reunida' && r.estado !== 'Vencida';
  };

  // Confirma el reencuentro: el servidor cierra tu reporte y el de la otra persona, y le avisa
  const confirmarReencuentro = async (nt: Notificacion) => {
    const ok = await confirmar(
      '¿Confirmas que la mascota ya regresó a casa?',
      'Confirma solo si la mascota ya fue entregada y está con su dueño. Se cerrarán ambos reportes y se avisará a la otra persona. No se puede deshacer desde la app.'
    );
    if (!ok) return;
    try {
      const token = await auth.currentUser?.getIdToken();
      const resp = await fetch(REENCUENTRO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notificacionId: nt.id }),
      });
      if (!resp.ok) throw new Error('fallo');
      setNotifVisible(false);
      avisar('¡Qué bueno!', 'Los reportes se marcaron como resueltos. Gracias por usar PetFind.');
    } catch {
      avisar('Error', 'No se pudo completar. Revisa tu conexión e intenta de nuevo.');
    }
  };

  const descartarNotificacion = async (nt: Notificacion) => {
    try {
      await deleteDoc(doc(db, 'notificaciones', nt.id));
    } catch {
      avisar('Error', 'No se pudo descartar el aviso.');
    }
  };

  const abrirNotificacion = async (nt: Notificacion) => {
    try {
      if (!nt.leida) await updateDoc(doc(db, 'notificaciones', nt.id), { leida: true });
    } catch {}
    // Los avisos de cierre solo informan: no hay reporte que abrir
    if (nt.tipo === 'cierre') return;
    const rep = reportes.find((r) => r.id === nt.reporteNuevoId);
    if (!rep) {
      avisar('Reporte no disponible', 'Ese reporte ya no está activo.');
      return;
    }
    setNotifVisible(false);
    setTimeout(() => abrirDetalle(rep), Platform.OS === 'ios' ? 450 : 0);
  };

  const marcarTodasLeidas = async () => {
    try {
      await Promise.all(
        notificaciones.filter((x) => !x.leida).map((x) => updateDoc(doc(db, 'notificaciones', x.id), { leida: true }))
      );
    } catch {}
  };

  // El reporte ya está guardado: una falla en los avisos no debe ocultarse ni duplicar la publicación.
  const notificarCoincidencias = async (reporteId: string) => {
    let reintentar = true;
    while (reintentar) {
      let detalle = 'No se pudo comprobar si hay coincidencias.';
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) throw new Error('Inicia sesión de nuevo para buscar coincidencias.');
        const resp = await fetch(NOTIFICAR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ reporteId }),
        });
        if (resp.ok) return;
        const resultado = await resp.json().catch(() => ({}));
        detalle = resultado.error || detalle;
        if (resp.status === 409) detalle = 'El reporte sigue analizándose. Puedes esperar antes de reintentar.';
      } catch (e) {
        detalle = e instanceof Error ? e.message : 'Revisa tu conexión.';
      }
      reintentar = await confirmar(
        'Reporte guardado; búsqueda pendiente',
        `${detalle} Tu reporte sigue publicado. ¿Quieres reintentar la búsqueda de coincidencias ahora?`
      );
    }
  };

  const recuperarPassword = async () => {
    if (recuperacionEnCurso.current || cargandoAuth) return;
    const correo = email.trim();
    if (!correo) {
      avisar('Escribe tu correo', 'Escribe tu correo electrónico en el campo de arriba y vuelve a pulsar “¿Olvidaste tu contraseña?”. No necesitas escribir la contraseña.');
      return;
    }
    recuperacionEnCurso.current = true;
    setRecuperandoPassword(true);
    const informar = () => avisar(
      'Revisa tu correo',
      'Si existe una cuenta asociada a ese correo, recibirás un enlace para restablecer tu contraseña. Revisa también la carpeta de spam. Después vuelve a PetFind e inicia sesión con la nueva contraseña.'
    );
    try {
      auth.languageCode = 'es';
      await sendPasswordResetEmail(auth, correo);
      informar();
    } catch (error: any) {
      switch (error.code) {
        case 'auth/user-not-found':
        case 'auth/user-disabled':
          informar();
          break;
        case 'auth/invalid-email':
        case 'auth/missing-email':
          avisar('Revisa el correo', 'Escribe una dirección de correo electrónico válida.');
          break;
        case 'auth/too-many-requests':
          avisar('Espera un momento', 'Se hicieron demasiadas solicitudes. Intenta de nuevo más tarde.');
          break;
        case 'auth/network-request-failed':
          avisar('Sin conexión', 'No se pudo solicitar el enlace. Revisa tu conexión e intenta de nuevo.');
          break;
        default:
          avisar('No se pudo solicitar el enlace', 'Intenta de nuevo en unos momentos.');
      }
    } finally {
      recuperacionEnCurso.current = false;
      setRecuperandoPassword(false);
    }
  };

  // Login / Registro con Firebase
  const handleLogin = async () => {
    if (recuperacionEnCurso.current || cargandoAuth) return;
    if (!email.trim() || !password.trim()) {
      avisar('Error', 'Ingresa tu correo y contraseña para continuar.');
      return;
    }
    if (modoRegistro && !aceptaPrivacidad) {
      avisar('Aviso de privacidad', 'Para crear tu cuenta debes aceptar el aviso de privacidad.');
      return;
    }
    setCargandoAuth(true);
    try {
      if (modoRegistro) {
        const validacion = await validatePassword(auth, password);
        setPoliticaPassword(validacion.passwordPolicy);
        setErrorPolitica(false);
        if (!validacion.isValid) {
          avisar('Revisa la contraseña', requisitosDePassword(validacion.passwordPolicy).join('\n'));
          return;
        }
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
      // Preparar la nueva sesión antes de activar las suscripciones.
      setCargandoReportes(true);
      setNotificaciones([]);
      setMostrarPassword(false);
      setSesionIniciada(true);
    } catch (error: any) {
      let mensaje = 'Ocurrió un error, intenta de nuevo.';
      switch (error.code) {
        case 'auth/invalid-email':
          mensaje = 'El correo electrónico no es válido.';
          break;
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          mensaje = 'Correo o contraseña incorrectos.';
          break;
        case 'auth/email-already-in-use':
          mensaje = 'Ya existe una cuenta con ese correo. Intenta iniciar sesión.';
          break;
        case 'auth/weak-password':
        case 'auth/password-does-not-meet-requirements':
          mensaje = 'La contraseña no cumple los requisitos indicados para crear la cuenta.';
          break;
      }
      avisar('Error', mensaje);
    } finally {
      setCargandoAuth(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch {}
    // Limpiar los datos de la sesión desde la acción de salir.
    setNotificaciones([]);
    setNotifVisible(false);
    setPerfilVisible(false);
    setPestanaPerfil('activos');
    setReportes([]);
    setCargandoReportes(true);
    setSesionIniciada(false);
    setEmail('');
    setPassword('');
    setMostrarPassword(false);
    setAceptaPrivacidad(false);
    limpiarFormulario(true);
  };

  // Pide permiso y devuelve la posición actual del dispositivo
  const obtenerUbicacion = async (): Promise<{ lat: number; lng: number } | null> => {
    try {
      const permiso = await Location.requestForegroundPermissionsAsync();
      if (permiso.status !== 'granted') {
        avisar('Permiso necesario', 'Activa el permiso de ubicación para continuar.');
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch {
      avisar('Error', 'No se pudo obtener tu ubicación. Revisa que el GPS esté activado.');
      return null;
    }
  };

  // Botón "Usar mi ubicación" del formulario: guarda coordenadas y rellena la zona
  const alRecibirPunto = (data: string) => {
    try {
      const m = JSON.parse(data);
      if (m.tipo === 'punto' && typeof m.lat === 'number' && typeof m.lng === 'number') {
        setCoordsReporte({ lat: m.lat, lng: m.lng });
        const previa = zonaAutoRef.current;
        nombreDeZona(m.lat, m.lng).then((nombre) => {
          if (!nombre) return;
          zonaAutoRef.current = nombre;
          setUbicacion((actual) =>
            actual === '' || actual === previa || actual === 'Ubicación marcada en el mapa' ? nombre : actual
          );
        });
      }
    } catch {}
  };

  const usarMiUbicacion = async () => {
    setObteniendoUbicacion(true);
    const pos = await obtenerUbicacion();
    if (pos) {
      setCoordsReporte(pos);
      setSelectorHtml(generarSelectorMapaHtml(pos, pos));
      const previa = zonaAutoRef.current;
      const nombre = await nombreDeZona(pos.lat, pos.lng);
      if (nombre) zonaAutoRef.current = nombre;
      setUbicacion((actual) =>
        actual === '' || actual === previa || actual === 'Ubicación marcada en el mapa'
          ? nombre || 'Ubicación marcada en el mapa'
          : actual
      );
    }
    setObteniendoUbicacion(false);
  };

  // En pantallas anchas (computadora) el contenido se centra en una columna
  const { width: anchoPantalla } = useWindowDimensions();
  const margenLateral = anchoPantalla > 1100 ? 32 : 0;
  const esEscritorio = Platform.OS === 'web' && anchoPantalla >= 900;
  const columnas = anchoPantalla >= 1500 ? 4 : anchoPantalla >= 1100 ? 3 : anchoPantalla >= 700 ? 2 : 1;
  const zonaAutoRef = useRef<string>('');

  // El HTML del selector solo cambia al abrir el formulario, editar o usar la ubicación actual.
  // Mover el marcador actualiza las coordenadas, pero conserva el mapa que ya está abierto.

  // Al iniciar sesión, intenta obtener la ubicación del usuario (distancias y mapa)
  useEffect(() => {
    if (!sesionIniciada || miUbicacion) return;
    let activa = true;
    (async () => {
      try {
        const permiso = await Location.requestForegroundPermissionsAsync();
        if (!activa || permiso.status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (activa) setMiUbicacion({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch {}
    })();
    return () => { activa = false; };
  }, [sesionIniciada, miUbicacion]);

  // Límite de seguridad: Firestore acepta máx. ~1 MB por documento
  const MAX_FOTO_BASE64 = 700000;

  // Elegir foto (cámara o galería) para el reporte.
  // Se comprime y se guarda como texto base64 dentro del propio reporte.
  const elegirFoto = async (origen: 'camara' | 'galeria') => {
    const permiso =
      origen === 'camara'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) {
      avisar('Permiso necesario', 'Activa el permiso para continuar.');
      return;
    }

    const opciones: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      quality: 0.3,
      base64: true,
      allowsEditing: true,
      aspect: [1, 1],
    };
    const resultado =
      origen === 'camara'
        ? await ImagePicker.launchCameraAsync(opciones)
        : await ImagePicker.launchImageLibraryAsync(opciones);

    if (resultado.canceled) return;

    const base64 = resultado.assets[0].base64;
    if (!base64) {
      avisar('Error', 'No se pudo leer la foto. Intenta con otra.');
      return;
    }
    if (base64.length > MAX_FOTO_BASE64) {
      avisar('Foto muy pesada', 'Intenta con otra foto o tómala de nuevo con menos zoom.');
      return;
    }
    setFotoLocal(`data:image/jpeg;base64,${base64}`);
  };

  // Deja el formulario vacío y lo cierra. Al publicar se conservan tipo y contacto para el siguiente reporte.
  const limpiarFormulario = (todo: boolean = false) => {
    setAvisoBorradorVisible(false);
    setNombre('');
    setRaza('');
    setUbicacion('');
    setDescripcion('');
    zonaAutoRef.current = '';
    setFotoLocal(null);
    setCoordsReporte(null);
    setEspecie('Perro');
    setEspecieOtro('');
    setOpcionCuando('ahora');
    setHayRecompensa(false);
    setRecompensaTexto('');
    if (todo) {
      setTipo('Perdida');
      setContactoNombre('');
      setTelefono('');
    }
    setEditandoId(null);
    setModalVisible(false);
  };

  const abrirFormulario = () => {
    setAvisoBorradorVisible(false);
    setSelectorHtml(generarSelectorMapaHtml(
      coordsReporte ?? miUbicacion ?? { lat: 25.6866, lng: -100.3161 },
      coordsReporte
    ));
    setModalVisible(true);
  };

  // La X y Atrás conservan el borrador nuevo; al editar descartan los cambios locales.
  const cerrarFormulario = () => {
    if (subiendo) return;
    if (editandoId) {
      limpiarFormulario(true);
      return;
    }
    // Un reporte nuevo permanece como borrador en esta sesión, incluida foto y ubicación.
    setModalVisible(false);
    setAvisoBorradorVisible(Boolean(
      nombre.trim() || raza.trim() || descripcion.trim() || contactoNombre.trim() ||
      telefono.trim() || fotoLocal || coordsReporte || ubicacion.trim() ||
      especieOtro.trim() || recompensaTexto.trim() || hayRecompensa ||
      especie !== 'Perro' || tipo !== 'Perdida' || opcionCuando !== 'ahora'
    ));
  };

  // Cancelar es una acción explícita para descartar, distinta de cerrar el borrador.
  const cancelarReporte = async () => {
    if (subiendo) return;
    const acepta = await confirmar(
      editandoId ? '¿Descartar los cambios?' : '¿Descartar este reporte?',
      editandoId
        ? 'Se descartarán los cambios sin guardar. El reporte publicado conservará sus datos originales.'
        : 'Se borrarán todos los datos y la foto de este borrador. No se publicará ningún reporte.'
    );
    if (!acepta) return;
    limpiarFormulario(true);
  };

  // Abre el formulario con los datos de un reporte propio para corregirlos
  const abrirEdicion = (r: ReporteMascota) => {
    setAvisoBorradorVisible(false);
    setEditandoId(r.id);
    setNombre(r.nombre);
    setRaza(r.raza === 'Sin especificar' ? '' : r.raza);
    setTipo(r.tipo);
    setEspecie(r.especie);
    setEspecieOtro(r.especieOtro ?? '');
    setContactoNombre(r.contactoNombre ?? '');
    setTelefono(r.telefono ?? '');
    setHayRecompensa(!!r.recompensa);
    setRecompensaTexto(r.recompensa && r.recompensa !== 'Sí' ? r.recompensa : '');
    setUbicacion(r.ubicacion ?? '');
    zonaAutoRef.current = r.ubicacion ?? '';
    setDescripcion(r.descripcion ?? '');
    setFotoLocal(r.foto || null);
    setCoordsReporte({ lat: r.latitud, lng: r.longitud });
    setSelectorHtml(generarSelectorMapaHtml(
      { lat: r.latitud, lng: r.longitud },
      { lat: r.latitud, lng: r.longitud }
    ));
    setDetalleVisible(false);
    setTimeout(() => setModalVisible(true), Platform.OS === 'ios' ? 450 : 0);
  };

  const guardarReporte = async () => {
    if (!nombre.trim()) {
      avisar('Falta el nombre', 'Escribe el nombre o apodo de la mascota.');
      return;
    }
    if (!coordsReporte) {
      avisar(
        'Falta marcar el punto',
        'Toca el mapa para marcar dónde estaba la mascota, o usa "Usar mi ubicación actual" si estás en el lugar.'
      );
      return;
    }
    if (!contactoNombre.trim()) {
      avisar('Falta tu nombre', 'Indica el nombre de quien reporta.');
      return;
    }
    if (telefono.replace(/\D/g, '').length < 10) {
      avisar('Teléfono inválido', 'Escribe un teléfono de 10 dígitos para que puedan contactarte.');
      return;
    }
    if (especie === 'Otro' && !especieOtro.trim()) {
      avisar('Falta la especie', 'Indica qué tipo de animal es.');
      return;
    }
    if (!fotoLocal) {
      avisar('Falta la foto', 'Agrega una foto de la mascota para poder identificarla.');
      return;
    }

    setSubiendo(true);
    try {
      const coords = coordsReporte;

      // Modo edición: solo se actualizan los datos; la fecha del suceso y el estado no cambian
      if (editandoId) {
        await updateDoc(doc(db, 'reportes', editandoId), {
          nombre,
          raza: raza || 'Sin especificar',
          tipo,
          especie,
          especieOtro: especie === 'Otro' ? especieOtro.trim() : '',
          contactoNombre: contactoNombre.trim(),
          telefono: telefono.replace(/\D/g, ''),
          recompensa: tipo === 'Perdida' && hayRecompensa ? recompensaTexto.trim() || 'Sí' : '',
          ubicacion: ubicacion.trim() || 'Ubicación marcada en el mapa',
          descripcion,
          foto: fotoLocal,
          latitud: coords.lat,
          longitud: coords.lng,
          editado: serverTimestamp(),
        });
        limpiarFormulario(true);
        avisar('Cambios guardados', 'Tu reporte se actualizó correctamente.');
        return;
      }

      const refNuevo = await addDoc(collection(db, 'reportes'), {
        nombre,
        raza: raza || 'Sin especificar',
        tipo,
        especie,
        especieOtro: especie === 'Otro' ? especieOtro.trim() : '',
        contactoNombre: contactoNombre.trim(),
        telefono: telefono.replace(/\D/g, ''),
        fechaEvento: new Date(
          Date.now() - (OPCIONES_CUANDO.find((o) => o.id === opcionCuando)?.min ?? 0) * 60000
        ).toISOString(),
        recompensa: tipo === 'Perdida' && hayRecompensa ? recompensaTexto.trim() || 'Sí' : '',
        ubicacion: ubicacion.trim() || 'Ubicación marcada en el mapa',
        descripcion,
        foto: fotoLocal,
        latitud: coords.lat,
        longitud: coords.lng,
        autorId: auth.currentUser?.uid ?? null,
        creado: serverTimestamp(),
      });
      // No hace falta actualizar la lista a mano: onSnapshot la refresca solo.
      // En segundo plano, el servidor busca mascotas parecidas y avisa a sus dueños.
      notificarCoincidencias(refNuevo.id);
      limpiarFormulario();
    } catch {
      avisar('Error', 'No se pudo guardar el reporte. Revisa tu conexión y las reglas de Firestore.');
    } finally {
      setSubiendo(false);
    }
  };

  // Escanear una mascota vista en la calle y buscar coincidencias
  const escanearFoto = async () => {
    if (ESCANEO_URL.startsWith('PENDIENTE')) {
      avisar(
        'Falta configurar',
        'Aún no has puesto la URL de tu Cloud Function en la constante ESCANEO_URL.'
      );
      return;
    }

    const permiso = await ImagePicker.requestCameraPermissionsAsync();
    if (!permiso.granted) {
      avisar('Permiso necesario', 'Activa el acceso a la cámara para escanear.');
      return;
    }

    const resultado = await ImagePicker.launchCameraAsync({
      quality: 0.3, // menos peso = más rápido y barato
      base64: true,
    });
    if (resultado.canceled) return;

    setEstadoImagenEscaner(null);
    setCoincidencias([]);
    setComparados(null);
    setEscaneando(true);
    try {
      // El token demuestra al servidor que hay una sesión iniciada
      const token = await auth.currentUser?.getIdToken();
      const resp = await fetch(ESCANEO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ imagen: resultado.assets[0].base64 }),
      });
      if (!resp.ok) {
        let detalle = '';
        try {
          detalle = (await resp.json()).error ?? '';
        } catch {}
        throw new Error(`${detalle || 'Error del servidor'} (código ${resp.status})`);
      }
      const data = await resp.json();
      const estado = data.estadoImagen;
      const estadoValido = estado === 'mascota' || estado === 'sin_mascota' || estado === 'no_clara' ? estado : null;
      setEstadoImagenEscaner(estadoValido);
      setCoincidencias(estadoValido === 'sin_mascota' || estadoValido === 'no_clara' ? [] : (data.coincidencias ?? []));
      setComparados(typeof data.comparados === 'number' ? data.comparados : null);
      setResultadosVisible(true);
    } catch (e) {
      avisar(
        'Error',
        e instanceof TypeError
          ? 'No se pudo conectar con el servidor del escáner. Revisa tu conexión.'
          : (e as Error).message || 'No se pudo analizar la foto. Intenta de nuevo.'
      );
    } finally {
      setEscaneando(false);
    }
  };

  const contactar = async (medio: 'llamar' | 'whatsapp', r: ReporteMascota) => {
    const digitos = (r.telefono ?? '').replace(/\D/g, '');
    if (!digitos) return;
    const url =
      medio === 'llamar'
        ? `tel:${digitos}`
        : `https://wa.me/${digitos.length === 10 ? '52' + digitos : digitos}?text=${encodeURIComponent(
            `Hola, vi el reporte de ${r.nombre} en PetFind.`
          )}`;
    try {
      await Linking.openURL(url);
    } catch {
      avisar('Error', 'No se pudo abrir la aplicación.');
    }
  };

  const marcarReunida = async (r: ReporteMascota) => {
    const ok = await confirmar(
      r.tipo === 'Perdida' ? '¿Ya regresó a casa?' : '¿Ya la entregaste a su dueño?',
      'El reporte dejará de aparecer como activo y se sumará a "Mascotas Reunidas".'
    );
    if (!ok) return;
    try {
      await updateDoc(doc(db, 'reportes', r.id), {
        estado: 'Reunida',
        fechaResolucion: serverTimestamp(),
      });
      setDetalleVisible(false);
      avisar('¡Qué bueno!', 'El reporte se marcó como resuelto. Gracias por usar PetFind.');
    } catch {
      avisar('Error', 'No se pudo actualizar el reporte. Revisa tu conexión.');
    }
  };

  const eliminarReporte = async (r: ReporteMascota) => {
    const ok = await confirmar(
      '¿Eliminar este reporte?',
      'Se borrará de forma permanente, con su foto y sus datos de contacto. No se puede deshacer.'
    );
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'reportes', r.id));
      setDetalleVisible(false);
      avisar('Reporte eliminado', 'El reporte se borró correctamente.');
    } catch {
      avisar('Error', 'No se pudo eliminar el reporte. Revisa tu conexión.');
    }
  };

  const abrirDetalle = (mascota: ReporteMascota) => {
    setMascotaDetalle(mascota);
    setDetalleVisible(true);
  };

  const limpiarFiltros = () => {
    setFiltroEstado('Todos');
    setFiltroEspecie('Todos');
    setBusqueda('');
  };

  // Aplica los 3 filtros combinados
  const reportesFiltrados = useMemo(() => reportes.filter((r) => {
    if (r.estado === 'Reunida' || r.estado === 'Vencida') return false;
    const pasaEstado = filtroEstado === 'Todos' || r.tipo === filtroEstado;
    const pasaEspecie = filtroEspecie === 'Todos' || r.especie === filtroEspecie;
    const texto = busqueda.trim().toLowerCase();
    const pasaBusqueda =
      texto === '' ||
      r.nombre.toLowerCase().includes(texto) ||
      r.raza.toLowerCase().includes(texto) ||
      (r.especieOtro ?? '').toLowerCase().includes(texto) ||
      r.ubicacion.toLowerCase().includes(texto);
    return pasaEstado && pasaEspecie && pasaBusqueda;
  }), [reportes, filtroEstado, filtroEspecie, busqueda]);

  const filtrosActivos = (filtroEstado !== 'Todos' ? 1 : 0) + (filtroEspecie !== 'Todos' ? 1 : 0);

  // "Más cercanos" necesita la ubicación; si no se tiene, se pide
  const seleccionarOrden = async (o: 'recientes' | 'cercanos') => {
    if (o === 'cercanos' && !miUbicacion) {
      const pos = await obtenerUbicacion();
      if (!pos) return;
      setMiUbicacion(pos);
    }
    setOrden(o);
  };

  const reportesOrdenados =
    orden === 'cercanos' && miUbicacion
      ? [...reportesFiltrados].sort(
          (a, b) =>
            distanciaKm(miUbicacion.lat, miUbicacion.lng, a.latitud, a.longitud) -
            distanciaKm(miUbicacion.lat, miUbicacion.lng, b.latitud, b.longitud)
        )
      : reportesFiltrados;

  const mapaHtml = useMemo(
    () => generarMapaReportesHtml(reportesFiltrados, miUbicacion),
    [reportesFiltrados, miUbicacion]
  );

  const abrirReporteDesdeMapa = (data: string) => {
    let mensaje;
    try {
      mensaje = JSON.parse(data);
    } catch {
      return;
    }
    if (mensaje?.tipo !== 'abrir-reporte' || typeof mensaje.id !== 'string') return;
    const reporte = reportesFiltrados.find((r) => r.id === mensaje.id);
    if (!reporte) {
      avisar('Reporte no disponible', 'Este reporte ya no está entre los reportes activos mostrados.');
      return;
    }
    abrirDetalle(reporte);
  };

  // Aviso de privacidad (se usa en el login y dentro de la app)
  const modalPrivacidad = (
    <Modal visible={privacidadVisible} transparent animationType="slide" onRequestClose={() => setPrivacidadVisible(false)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContenido, { maxHeight: '85%' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <IcoTexto n="shield-checkmark-outline" s={22} c={PRIMARY_DARK} textoStyle={{ fontSize: 18, fontWeight: 'bold', color: '#222' }}>
              Aviso de privacidad
            </IcoTexto>
            <TouchableOpacity onPress={() => setPrivacidadVisible(false)} accessibilityLabel="Cerrar aviso de privacidad">
              <Ico n="close" s={22} c="#333" />
            </TouchableOpacity>
          </View>
          <ScrollView>
            {AVISO_PRIVACIDAD.map((sec) => (
              <View key={sec.t} style={{ marginBottom: 12 }}>
                <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#222', marginBottom: 2 }}>{sec.t}</Text>
                <Text style={{ fontSize: 13, color: '#444', lineHeight: 19 }}>{sec.x}</Text>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity
            style={[styles.botonGuardar, { alignItems: 'center', marginTop: 8 }]}
            onPress={() => setPrivacidadVisible(false)}
          >
            <Text style={styles.textoBlanco}>Entendido</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // ==========================================================
  // VISTA 1: Pantalla de Login
  // ==========================================================
  if (!sesionIniciada) {
    return (
      <SafeAreaView style={styles.contenedorLogin}>
        <StatusBar backgroundColor={PRIMARY_DARK} barStyle="light-content" />
        <ScrollView style={{ width: '100%' }} contentContainerStyle={styles.loginContenido} keyboardShouldPersistTaps="handled">
        <View style={styles.tarjetaLogin}>
          <Image
            source={require('./assets/logo-sin-eslogan.png')}
            style={{ width: 150, height: 200, alignSelf: 'center' }}
            resizeMode="contain"
          />
          <Text style={styles.subtituloLogin}>
            Red comunitaria para el reporte y localización de mascotas
          </Text>

          <View style={styles.formContainer}>
            <Text style={styles.labelInput}>Correo Electrónico</Text>
            <TextInput
              style={styles.inputLogin}
              placeholder="correo@ejemplo.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Correo electrónico"
            />
            <Text style={styles.labelInput}>Contraseña</Text>
            <View style={styles.passwordFila}>
              <TextInput
                style={styles.passwordCampo}
                placeholder="Escribe tu contraseña"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!mostrarPassword}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Contraseña"
              />
              <TouchableOpacity
                style={styles.passwordBoton}
                onPress={() => setMostrarPassword((visible) => !visible)}
                accessibilityRole="button"
                accessibilityLabel={mostrarPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                accessibilityState={{ expanded: mostrarPassword }}
              >
                <Ico n={mostrarPassword ? 'eye-off-outline' : 'eye-outline'} s={21} c={PRIMARY_DARK} />
                <Text style={styles.passwordBotonTexto}>{mostrarPassword ? 'Ocultar' : 'Mostrar'}</Text>
              </TouchableOpacity>
            </View>
            {!modoRegistro && (
              <View style={{ marginBottom: 12 }}>
                <TouchableOpacity
                  onPress={recuperarPassword}
                  disabled={recuperandoPassword || cargandoAuth}
                  accessibilityRole="button"
                  accessibilityLabel="Solicitar enlace para restablecer contraseña"
                  accessibilityHint="Usa el correo escrito en el campo de correo electrónico"
                  accessibilityState={{ disabled: recuperandoPassword || cargandoAuth, busy: recuperandoPassword }}
                  style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center', opacity: recuperandoPassword || cargandoAuth ? 0.6 : 1 }}
                >
                  <Text style={{ color: PRIMARY_DARK, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' }}>
                    {recuperandoPassword ? 'Solicitando enlace…' : '¿Olvidaste tu contraseña?'}
                  </Text>
                </TouchableOpacity>
                <Text style={{ color: '#555', fontSize: 12, lineHeight: 18, textAlign: 'center' }}>
                  Usaremos el correo escrito arriba.
                </Text>
              </View>
            )}
            {modoRegistro && (
              <View style={styles.passwordAyuda}>
                <Text style={styles.passwordAyudaTitulo}>Requisitos de contraseña</Text>
                <Text style={styles.passwordAyudaTexto}>
                  {errorPolitica
                    ? 'No pudimos consultar los requisitos. Comprueba tu conexión; se volverán a verificar al crear la cuenta.'
                    : politicaPassword
                    ? `${requisitosDePassword(politicaPassword, false).join(' · ').replace(/^Al menos/, 'Usa al menos') || 'La contraseña se verificará al crear la cuenta'}. Para mayor seguridad, elige una contraseña larga y única.`
                    : 'Consultando los requisitos de Firebase…'}
                </Text>
              </View>
            )}
            {modoRegistro && (
              <TouchableOpacity
                onPress={() => setAceptaPrivacidad(!aceptaPrivacidad)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: aceptaPrivacidad }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 4 }}
              >
                <Ico n={aceptaPrivacidad ? 'checkbox' : 'square-outline'} s={24} c={PRIMARY_DARK} />
                <Text style={{ flex: 1, fontSize: 13, color: '#444', lineHeight: 18 }}>
                  Acepto el{' '}
                  <Text
                    style={{ color: PRIMARY_DARK, fontWeight: '700', textDecorationLine: 'underline' }}
                    onPress={() => setPrivacidadVisible(true)}
                  >
                    aviso de privacidad
                  </Text>
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.botonIngresar}
              onPress={handleLogin}
              disabled={cargandoAuth || recuperandoPassword}
            >
              <Text style={styles.textoBotonIngresar}>
                {cargandoAuth ? 'Cargando...' : modoRegistro ? 'Crear cuenta' : 'Iniciar Sesión'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ marginTop: 16, alignItems: 'center' }}
              onPress={() => { setMostrarPassword(false); setModoRegistro(!modoRegistro); }}
              disabled={cargandoAuth || recuperandoPassword}
            >
              <Text style={{ color: PRIMARY_DARK, fontWeight: '600' }}>
                {modoRegistro ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={() => setPrivacidadVisible(true)}>
              <Text style={{ color: '#6b6b6b', fontSize: 13, textDecorationLine: 'underline' }}>Aviso de privacidad</Text>
            </TouchableOpacity>
          </View>
        </View>
        </ScrollView>
        {modalPrivacidad}
      </SafeAreaView>
    );
  }

  // ==========================================================
  // VISTA 2: Dashboard principal (nuevo diseño)
  // ==========================================================
  return (
    <SafeAreaView style={styles.contenedorPrincipal}>
      <StatusBar backgroundColor={PRIMARY_DARK} barStyle="light-content" />

      {/* Barra de navegación superior */}
      <View style={[styles.navbar, { paddingHorizontal: 16 + margenLateral }]}>
        <View style={styles.navbarLogo}>
          <Image
            source={require('./assets/logo-icon.png')}
            style={{ width: 30, height: 36 }}
            resizeMode="contain"
          />
          <View>
            <Text style={styles.navbarTitulo}>PetFind</Text>
            <Text style={styles.navbarSubtitulo}>LOCALIZADOR DE MASCOTAS</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {esEscritorio && (
            <>
              <TouchableOpacity
                style={[styles.navLink, vistaActual === 'lista' && styles.navLinkActivo]}
                onPress={() => setVistaActual('lista')}
              >
                <Text style={[styles.navLinkTexto, vistaActual === 'lista' && styles.navLinkTextoActivo]}>Inicio</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.navLink, vistaActual === 'mapa' && styles.navLinkActivo]}
                onPress={() => setVistaActual('mapa')}
              >
                <Text style={[styles.navLinkTexto, vistaActual === 'mapa' && styles.navLinkTextoActivo]}>Mapa</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.navLink} onPress={escanearFoto}>
                <IcoTexto n="camera-outline" s={17} c="#555" textoStyle={styles.navLinkTexto}>Escanear</IcoTexto>
              </TouchableOpacity>
              <TouchableOpacity style={styles.navBotonPrincipal} onPress={abrirFormulario}>
                <IcoTexto n="add" s={20} c="#fff" textoStyle={{ color: '#fff', fontWeight: 'bold', fontSize: 14 }}>Reportar</IcoTexto>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={styles.navbarIconoBoton} onPress={() => setNotifVisible(true)} accessibilityLabel="Avisos">
            <Ico n={sinLeer > 0 ? 'notifications' : 'notifications-outline'} s={20} c="#555" />
            {sinLeer > 0 && (
              <View style={styles.badgeAviso}>
                <Text style={styles.badgeAvisoTexto}>{sinLeer > 9 ? '9+' : sinLeer}</Text>
              </View>
            )}
          </TouchableOpacity>
          {esEscritorio && (
            <TouchableOpacity
              style={styles.navbarIconoBoton}
              onPress={() => {
                setPasoGuia(0);
                setGuiaVisible(true);
              }}
              accessibilityLabel="Ayuda"
            >
              <Ico n="help-circle-outline" s={21} c="#555" />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.navbarIconoBoton} onPress={() => setPerfilVisible(true)} accessibilityRole="button" accessibilityLabel="Abrir mi perfil">
            <Ico n="person-circle-outline" s={26} c={PRIMARY_DARK} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Barra de estado / estadísticas */}
      <View style={[styles.statusBar, { paddingHorizontal: 16 + margenLateral }]}>
        <View style={styles.statusBarIzquierda}>
          <View style={styles.puntoActivo} />
          <Text style={styles.statusBarTexto}>Encuentra a tu mascota</Text>
        </View>
        <View style={styles.statusBarDerecha}>
          <IcoTexto n="heart" s={14} c="#fff" textoStyle={styles.statusBarStat}>{mascotasReunidas} Mascotas Reunidas</IcoTexto>
          <IcoTexto n="warning" s={14} c="#fff" textoStyle={styles.statusBarStat}>{reportesActivos.length} Reportes Activos</IcoTexto>
        </View>
      </View>

      {vistaActual === 'mapa' && (
        <View style={{ flex: 1 }}>
          <VistaHtml html={mapaHtml} onMensaje={abrirReporteDesdeMapa} />
        </View>
      )}

      {vistaActual === 'lista' && (
      <ScrollView
        style={styles.contenido}
        contentContainerStyle={{ paddingVertical: 14, paddingHorizontal: 14 + margenLateral, paddingBottom: 110 }}
      >
        {/* Panel de filtros */}
        <View style={styles.panelFiltros}>
          <View style={{ justifyContent: 'center' }}>
            <View style={{ position: 'absolute', left: 12, zIndex: 1 }} pointerEvents="none">
              <Ico n="search" s={18} c="#888" />
            </View>
            <TextInput
              style={[styles.buscador, { marginTop: 0, paddingLeft: 38 }]}
              placeholder="Buscar por raza, nombre o zona..."
              value={busqueda}
              onChangeText={setBusqueda}
            />
          </View>

          <View style={styles.barraControles}>
            <TouchableOpacity
              style={[styles.chipFiltro, (mostrarFiltros || filtrosActivos > 0) && styles.chipFiltroActivo]}
              onPress={() => setMostrarFiltros(!mostrarFiltros)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ico n="options-outline" s={15} c={mostrarFiltros || filtrosActivos > 0 ? '#fff' : '#555'} />
                <Text
                  style={[
                    styles.chipFiltroTexto,
                    (mostrarFiltros || filtrosActivos > 0) && styles.chipFiltroTextoActivo,
                  ]}
                >
                  Filtros{filtrosActivos > 0 ? ` (${filtrosActivos})` : ''}
                </Text>
                <Ico
                  n={mostrarFiltros ? 'chevron-up' : 'chevron-down'}
                  s={13}
                  c={mostrarFiltros || filtrosActivos > 0 ? '#fff' : '#555'}
                />
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chipFiltro, orden === 'recientes' && styles.chipFiltroActivo]}
              onPress={() => seleccionarOrden('recientes')}
            >
              <IcoTexto
                n="time-outline"
                s={15}
                c={orden === 'recientes' ? '#fff' : '#555'}
                textoStyle={[styles.chipFiltroTexto, orden === 'recientes' && styles.chipFiltroTextoActivo]}
              >
                Recientes
              </IcoTexto>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chipFiltro, orden === 'cercanos' && styles.chipFiltroActivo]}
              onPress={() => seleccionarOrden('cercanos')}
            >
              <IcoTexto
                n="location-outline"
                s={15}
                c={orden === 'cercanos' ? '#fff' : '#555'}
                textoStyle={[styles.chipFiltroTexto, orden === 'cercanos' && styles.chipFiltroTextoActivo]}
              >
                Cercanos
              </IcoTexto>
            </TouchableOpacity>
            {(filtrosActivos > 0 || busqueda !== '') && (
              <TouchableOpacity onPress={limpiarFiltros} style={{ marginLeft: 'auto' }}>
                <Text style={styles.filtrosLimpiar}>Limpiar</Text>
              </TouchableOpacity>
            )}
          </View>

          {mostrarFiltros && (
            <View>
              <Text style={styles.filtrosLabel}>ESTADO</Text>
              <View style={styles.filtrosFila}>
                {(['Todos', 'Perdida', 'Encontrada'] as const).map((op) => (
                  <TouchableOpacity
                    key={op}
                    style={[styles.chipFiltro, filtroEstado === op && styles.chipFiltroActivo]}
                    onPress={() => setFiltroEstado(op)}
                  >
                    <Text style={[styles.chipFiltroTexto, filtroEstado === op && styles.chipFiltroTextoActivo]}>
                      {op === 'Perdida' ? 'Perdidos' : op === 'Encontrada' ? 'Encontrados' : 'Todos'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.filtrosLabel}>ESPECIE</Text>
              <View style={styles.filtrosFila}>
                {(['Todos', 'Perro', 'Gato', 'Otro'] as const).map((op) => (
                  <TouchableOpacity
                    key={op}
                    style={[styles.chipFiltro, filtroEspecie === op && styles.chipFiltroActivo]}
                    onPress={() => setFiltroEspecie(op)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      {op !== 'Todos' && (
                        <Ico
                          mci
                          n={op === 'Perro' ? 'dog' : op === 'Gato' ? 'cat' : 'paw'}
                          s={16}
                          c={filtroEspecie === op ? '#fff' : '#555'}
                        />
                      )}
                      <Text style={[styles.chipFiltroTexto, filtroEspecie === op && styles.chipFiltroTextoActivo]}>
                        {op === 'Perro' ? 'Perros' : op === 'Gato' ? 'Gatos' : op === 'Otro' ? 'Otros' : 'Todos'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Lista de reportes filtrados */}
          <View style={{ marginTop: 14 }}>
            {cargandoReportes ? (
              <View>
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}
                >
                  <ActivityIndicator size="small" color={PRIMARY_DARK} />
                  <Text style={{ color: '#6b6b6b', fontSize: 13 }}>Cargando reportes...</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 }}>
                  {Array.from({ length: columnas * 2 }).map((_, i) => (
                    <View key={i} style={{ width: `${100 / columnas}%` as any, padding: 5 }}>
                      <TarjetaEsqueleto vertical />
                    </View>
                  ))}
                </View>
              </View>
            ) : reportesOrdenados.length === 0 ? (
              reportesActivos.length === 0 ? (
                <EstadoVacio
                  mci
                  icono="paw"
                  titulo="Aún no hay reportes"
                  texto="Sé el primero en publicar una alerta de una mascota perdida o encontrada."
                  boton="Publicar alerta"
                  onBoton={abrirFormulario}
                />
              ) : (
                <EstadoVacio
                  icono="search"
                  titulo="Sin resultados"
                  texto="Ninguna mascota coincide con tu búsqueda o tus filtros. Prueba con otros datos."
                  boton="Limpiar filtros"
                  onBoton={limpiarFiltros}
                />
              )
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 }}>
              {reportesOrdenados.map((item) => {
                const esPerdida = item.tipo === 'Perdida';
                const zona = zonaUtil(item.ubicacion);
                const vertical = true;
                const etiqueta = (
                  <View
                    style={[
                      styles.badge,
                      { backgroundColor: esPerdida ? '#ffebee' : '#e8f5e9' },
                      vertical && { position: 'absolute', top: 10, left: 10 },
                    ]}
                  >
                    <Text style={{ color: esPerdida ? '#c62828' : '#2e7d32', fontWeight: 'bold', fontSize: 11 }}>
                      {esPerdida ? 'PERDIDO' : 'ENCONTRADO'}
                    </Text>
                  </View>
                );
                const datos = (
                  <View style={[styles.tarjetaInfo, styles.reporteDatos]}>
                    <Text style={styles.reporteNombre}>{item.nombre}</Text>
                    <Text style={styles.reporteRaza}>
                      {item.especie === 'Otro' && item.especieOtro ? `${item.especieOtro} · ` : ''}
                      {razaVisible(item.raza)}
                    </Text>
                    {zona ? (
                      <IcoTexto n="location-outline" s={16} c="#555f5b" textoStyle={styles.reporteMeta}>
                        {zona}
                      </IcoTexto>
                    ) : null}
                    {item.fechaEvento ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 10 }}>
                        <IcoTexto n="time-outline" s={16} c="#555f5b" textoStyle={styles.reporteMeta}>
                          {esPerdida ? 'Se perdió' : 'Se encontró'} {tiempoRelativo(item.fechaEvento)}
                        </IcoTexto>
                        {item.recompensa ? (
                          <IcoTexto
                            n="gift-outline"
                            s={12}
                            c="#8a5a00"
                            textoStyle={[styles.reporteMeta, { color: '#8a5a00' }]}
                          >
                            Recompensa
                          </IcoTexto>
                        ) : null}
                      </View>
                    ) : null}
                    {miUbicacion ? (
                      <IcoTexto n="navigate-outline" s={16} c="#555f5b" textoStyle={styles.reporteMeta}>
                        A {formatoDistancia(distanciaKm(miUbicacion.lat, miUbicacion.lng, item.latitud, item.longitud))} de tu ubicación
                      </IcoTexto>
                    ) : null}
                  </View>
                );
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={{ width: `${100 / columnas}%` as any, padding: 5 }}
                    onPress={() => abrirDetalle(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Ver reporte de ${item.nombre}, mascota ${esPerdida ? 'perdida' : 'encontrada'}, ${razaVisible(item.raza)}${zona ? `, ${zona}` : ''}`}
                    accessibilityHint="Abre los detalles y las opciones de contacto del reporte"
                    activeOpacity={0.85}
                  >
                    {vertical ? (
                      <View style={styles.tarjetaVertical}>
                        <View>
                          <Image source={{ uri: item.foto }} style={styles.tarjetaFotoGrande} resizeMode="contain" />
                          {etiqueta}
                        </View>
                        {datos}
                      </View>
                    ) : (
                      <View style={styles.tarjetaCuadro}>
                        <Image source={{ uri: item.foto }} style={styles.tarjetaFoto} resizeMode="contain" />
                        {datos}
                        {etiqueta}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
              </View>
            )}
          </View>

          {/* Leyenda */}
          <View style={styles.leyenda}>
            <View style={styles.leyendaItem}>
              <View style={[styles.leyendaDot, { backgroundColor: '#e53935' }]} />
              <Text style={styles.leyendaTexto}>Mascota Perdida</Text>
            </View>
            <View style={styles.leyendaItem}>
              <View style={[styles.leyendaDot, { backgroundColor: PRIMARY_COLOR }]} />
              <Text style={styles.leyendaTexto}>Mascota Encontrada</Text>
            </View>
          </View>
        </View>
      </ScrollView>
      )}

      {/* Barra de navegación inferior */}
      {!esEscritorio && (
      <View style={[styles.barraInferior, { paddingHorizontal: margenLateral }]}>
        <TouchableOpacity style={styles.tabItem} onPress={() => setVistaActual('lista')}>
          <Ico n={vistaActual === 'lista' ? 'home' : 'home-outline'} s={23} c={vistaActual === 'lista' ? PRIMARY_DARK : '#777'} />
          <Text style={[styles.tabTexto, vistaActual === 'lista' && styles.tabTextoActivo]}>Inicio</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => setVistaActual('mapa')}>
          <Ico n={vistaActual === 'mapa' ? 'map' : 'map-outline'} s={23} c={vistaActual === 'mapa' ? PRIMARY_DARK : '#777'} />
          <Text style={[styles.tabTexto, vistaActual === 'mapa' && styles.tabTextoActivo]}>Mapa</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, escaneando && { opacity: 0.6 }]}
          onPress={escanearFoto}
          disabled={escaneando}
          accessibilityRole="button"
          accessibilityLabel={escaneando ? 'Analizando foto' : 'Escanear una mascota'}
          accessibilityState={{ disabled: escaneando, busy: escaneando }}
        >
          <Ico n="camera-outline" s={23} c={PRIMARY_DARK} />
          <Text style={[styles.tabTexto, styles.tabTextoActivo]}>{escaneando ? 'Analizando…' : 'Escanear'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={abrirFormulario}>
          <View style={styles.tabReportar}>
            <Ico n="add" s={26} c="#fff" />
          </View>
          <Text style={styles.tabTexto}>Reportar</Text>
        </TouchableOpacity>
      </View>
      )}

      {avisoBorradorVisible && (
        <View pointerEvents="none" style={[styles.avisoBorrador, { bottom: esEscritorio ? 24 : 88 }]}>
          <Text accessibilityLiveRegion="polite" style={styles.avisoBorradorTexto}>Borrador conservado durante esta sesión.</Text>
        </View>
      )}

      {modalPrivacidad}

      {/* Guía de primer uso */}
      <Modal visible={guiaVisible} transparent animationType="fade" onRequestClose={cerrarGuia}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContenido, { alignItems: 'center', paddingVertical: 26 }]}>
            <View
              style={{
                width: 84,
                height: 84,
                borderRadius: 42,
                backgroundColor: '#e6f8f1',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Ico n={pasoActual.icono} mci={pasoActual.mci} s={42} c={PRIMARY_DARK} />
            </View>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#222', textAlign: 'center', marginBottom: 8 }}>
              {pasoActual.titulo}
            </Text>
            <Text style={{ fontSize: 14, color: '#555', textAlign: 'center', lineHeight: 21, marginBottom: 18 }}>
              {pasoActual.texto}
            </Text>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 18 }}>
              {PASOS_GUIA.map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: i === pasoGuia ? 18 : 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: i === pasoGuia ? PRIMARY_DARK : '#d9dedc',
                  }}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
              <TouchableOpacity onPress={cerrarGuia}>
                <Text style={{ color: '#6b6b6b', fontSize: 14, padding: 8 }}>{esUltimoPaso ? '' : 'Saltar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.botonGuardar}
                onPress={() => (esUltimoPaso ? cerrarGuia() : setPasoGuia(pasoGuia + 1))}
              >
                <Text style={styles.textoBlanco}>{esUltimoPaso ? 'Empezar' : 'Siguiente'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Perfil de la cuenta: usa siempre el UID de la sesión actual. */}
      <Modal visible={perfilVisible} transparent animationType="slide" onRequestClose={() => setPerfilVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.perfilPanel}>
            <View style={styles.perfilCabecera}>
              <Text style={[styles.modalTitulo, { marginBottom: 0 }]}>Mi perfil</Text>
              <TouchableOpacity style={styles.formularioCerrar} onPress={() => setPerfilVisible(false)} accessibilityRole="button" accessibilityLabel="Cerrar mi perfil">
                <Ico n="close" s={24} c="#333" />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 18 }}>
              <View style={styles.perfilCuenta}>
                <Ico n="person-circle-outline" s={48} c={PRIMARY_DARK} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.perfilNombre}>Tu cuenta PetFind</Text>
                  <Text selectable style={styles.perfilTexto}>{auth.currentUser?.email || email}</Text>
                </View>
              </View>
              <Text style={styles.perfilNombre}>Mis reportes</Text>
              <Text style={[styles.perfilTexto, { marginTop: 4, marginBottom: 14 }]}>Aquí puedes administrar los reportes que publicaste con esta cuenta.</Text>
              <View style={styles.perfilPestanas}>
                {(['activos', 'resueltos', 'vencidos'] as const).map((pestana) => (
                  <TouchableOpacity key={pestana} accessibilityRole="tab" accessibilityState={{ selected: pestanaPerfil === pestana }} onPress={() => setPestanaPerfil(pestana)} style={[styles.perfilPestana, pestanaPerfil === pestana && styles.perfilPestanaActiva]}>
                    <Text style={{ color: pestanaPerfil === pestana ? '#fff' : PRIMARY_DARK, fontWeight: '700', textAlign: 'center', fontSize: 13 }}>
                      {pestana === 'activos' ? 'Activos' : pestana === 'resueltos' ? 'Resueltos' : 'Vencidos'} ({gruposPerfil[pestana].length})
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {cargandoReportes ? (
                <ActivityIndicator color={PRIMARY_DARK} style={{ marginVertical: 28 }} accessibilityLabel="Cargando mis reportes" />
              ) : gruposPerfil[pestanaPerfil].length === 0 ? (
                <View style={styles.perfilVacio}>
                  <Ico n="document-text-outline" s={36} c="#78877f" />
                  <Text style={[styles.perfilNombre, { marginTop: 10 }]}>No tienes reportes {pestanaPerfil}</Text>
                  <Text style={[styles.perfilTexto, { textAlign: 'center', marginTop: 6 }]}>Los reportes de esta categoría aparecerán aquí.</Text>
                </View>
              ) : gruposPerfil[pestanaPerfil].map((r) => (
                <View key={r.id} style={styles.perfilReporte}>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    {r.foto ? <Image source={{ uri: r.foto }} style={{ width: 72, height: 82, borderRadius: 10, backgroundColor: '#edf2ef' }} resizeMode="contain" accessibilityLabel={`Foto de ${r.nombre}`} /> : null}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.perfilNombre}>{r.nombre || 'Mascota sin nombre'}</Text>
                      <Text style={[styles.perfilTexto, { color: PRIMARY_DARK, marginTop: 3 }]}>{r.tipo === 'Perdida' ? 'Mascota perdida' : 'Mascota encontrada'} · {r.estado === 'Reunida' ? 'Resuelto' : r.estado === 'Vencida' ? 'Vencido' : 'Activo'}</Text>
                      <Text style={[styles.perfilTexto, { marginTop: 4 }]}>{r.ubicacion}</Text>
                    </View>
                  </View>
                  <View style={styles.perfilAcciones}>
                    <TouchableOpacity style={styles.perfilAccion} accessibilityRole="button" accessibilityLabel={`Ver reporte de ${r.nombre}`} onPress={() => { setPerfilVisible(false); setTimeout(() => abrirDetalle(r), Platform.OS === 'ios' ? 450 : 0); }}>
                      <Text style={styles.perfilAccionTexto}>Ver reporte</Text>
                    </TouchableOpacity>
                    {r.estado !== 'Reunida' && r.estado !== 'Vencida' && (
                      <TouchableOpacity style={styles.perfilAccion} accessibilityRole="button" accessibilityLabel={`Editar reporte de ${r.nombre}`} onPress={() => { setPerfilVisible(false); setTimeout(() => abrirEdicion(r), Platform.OS === 'ios' ? 450 : 0); }}>
                        <Text style={styles.perfilAccionTexto}>Editar</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.perfilAccion} accessibilityRole="button" accessibilityLabel={`Eliminar reporte de ${r.nombre}`} onPress={() => eliminarReporte(r)}>
                      <Text style={[styles.perfilAccionTexto, { color: '#b42318' }]}>Eliminar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <Text style={[styles.perfilTexto, { fontSize: 12, marginTop: 4, marginBottom: 18 }]}>Este listado no es un historial permanente. Los reportes resueltos se borran a los 30 días; los activos pasan a vencidos a los 90 días.</Text>
              <TouchableOpacity style={styles.perfilEnlace} accessibilityRole="button" onPress={() => { setPerfilVisible(false); setTimeout(() => setPrivacidadVisible(true), Platform.OS === 'ios' ? 450 : 0); }}>
                <Ico n="shield-checkmark-outline" s={21} c={PRIMARY_DARK} />
                <Text style={styles.perfilAccionTexto}>Aviso de privacidad y contacto</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.perfilEnlace, { marginTop: 10 }]} accessibilityRole="button" onPress={handleLogout}>
                <Ico n="log-out-outline" s={21} c="#b42318" />
                <Text style={[styles.perfilAccionTexto, { color: '#b42318' }]}>Cerrar sesión</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Avisos de coincidencias */}
      <Modal visible={notifVisible} transparent animationType="slide" onRequestClose={() => setNotifVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContenido, { maxHeight: '85%' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={[styles.modalTitulo, { marginBottom: 0 }]}>Avisos</Text>
              <TouchableOpacity onPress={() => setNotifVisible(false)}>
                <Ico n="close" s={22} c="#333" />
              </TouchableOpacity>
            </View>
            {notificaciones.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                <Ico n="notifications-outline" s={40} c="#8a9590" />
                <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#222', marginTop: 10, marginBottom: 4 }}>
                  Aún no tienes avisos
                </Text>
                <Text style={{ fontSize: 13, color: '#555', textAlign: 'center', maxWidth: 280, lineHeight: 19 }}>
                  Te avisaremos aquí si alguien publica una mascota parecida a la tuya.
                </Text>
              </View>
            ) : (
              <ScrollView>
                {notificaciones.map((nt) => (
                  <TouchableOpacity
                    key={nt.id}
                    onPress={() => abrirNotificacion(nt)}
                    style={{
                      flexDirection: 'row',
                      gap: 10,
                      padding: 12,
                      borderRadius: 10,
                      backgroundColor: nt.leida ? '#fff' : '#e6f8f1',
                      borderWidth: 1,
                      borderColor: '#eee',
                      marginBottom: 8,
                    }}
                  >
                    <Ico
                      mci={nt.tipo !== 'cierre'}
                      n={nt.tipo === 'cierre' ? 'checkmark-circle' : 'paw'}
                      s={22}
                      c={PRIMARY_DARK}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontWeight: 'bold', fontSize: 14, color: '#222' }}>
                        {nt.tipo === 'cierre'
                          ? `Reporte cerrado: ${nt.tuReporteNombre || 'tu reporte'}`
                          : `Posible coincidencia con ${nt.tuReporteNombre || 'tu reporte'}`}
                      </Text>
                      <Text style={{ fontSize: 13, color: '#555', marginTop: 2, lineHeight: 18 }}>
                        {nt.tipo === 'cierre'
                          ? nt.motivo
                          : `${
                              nt.reporteNuevoTipo === 'Encontrada'
                                ? 'Alguien encontró una mascota parecida'
                                : 'Alguien reportó una mascota perdida parecida'
                            }${nt.reporteNuevoNombre ? `: ${nt.reporteNuevoNombre}` : ''} (${nt.similitud}% de parecido).${
                              nt.motivo ? ` ${nt.motivo}` : ''
                            }`}
                      </Text>
                      {nt.tipo !== 'cierre' && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, marginTop: 8 }}>
                          <TouchableOpacity onPress={() => abrirNotificacion(nt)}>
                            <Text style={{ fontSize: 12, color: PRIMARY_DARK, fontWeight: '700' }}>Ver reporte</Text>
                          </TouchableOpacity>
                          {reporteEstaActivo(nt.tuReporteId) && (
                            <TouchableOpacity onPress={() => confirmarReencuentro(nt)}>
                              <Text style={{ fontSize: 12, color: PRIMARY_DARK, fontWeight: '700' }}>
                                {nt.reporteNuevoTipo === 'Encontrada' ? 'Confirmar reencuentro' : 'Ya la entregué a su dueño'}
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      )}
                    </View>
                    <View style={{ alignItems: 'center', gap: 8 }}>
                      <TouchableOpacity onPress={() => descartarNotificacion(nt)} accessibilityLabel="Descartar aviso">
                        <Ico n="close-circle-outline" s={20} c="#6b6b6b" />
                      </TouchableOpacity>
                      {!nt.leida && (
                        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: '#d32f2f' }} />
                      )}
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            {sinLeer > 0 && (
              <TouchableOpacity onPress={marcarTodasLeidas} style={{ alignItems: 'center', paddingTop: 10 }}>
                <Text style={{ color: PRIMARY_DARK, fontWeight: '600', fontSize: 13 }}>Marcar todas como leídas</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => {
                setNotifVisible(false);
                setPasoGuia(0);
                setTimeout(() => setGuiaVisible(true), Platform.OS === 'ios' ? 450 : 0);
              }}
              style={{ alignItems: 'center', paddingTop: 12 }}
            >
              <IcoTexto n="help-circle-outline" s={16} c="#6b6b6b" textoStyle={{ color: '#6b6b6b', fontSize: 13 }}>
                Ver guía de uso
              </IcoTexto>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setNotifVisible(false);
                setTimeout(() => setPrivacidadVisible(true), Platform.OS === 'ios' ? 450 : 0);
              }}
              style={{ alignItems: 'center', paddingTop: 8 }}
            >
              <IcoTexto n="shield-checkmark-outline" s={16} c="#6b6b6b" textoStyle={{ color: '#6b6b6b', fontSize: 13 }}>
                Aviso de privacidad
              </IcoTexto>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal: Publicar Reporte */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={cerrarFormulario}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContenido, { maxHeight: '92%', maxWidth: 560 }]}>
            <View style={styles.formularioCabecera}>
              <Text accessibilityRole="header" style={[styles.modalTitulo, { flex: 1, marginBottom: 0 }]}>
                {editandoId ? 'Editar reporte' : 'Publicar alerta'}
              </Text>
              <TouchableOpacity
                onPress={cerrarFormulario}
                style={[styles.formularioCerrar, subiendo && { opacity: 0.5 }]}
                disabled={subiendo}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de reporte"
                accessibilityState={{ disabled: subiendo }}
              >
                <Ico n="close" s={24} c="#222" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
            <Text style={styles.formularioAyuda}>Los campos con * son obligatorios.</Text>
            <Text style={styles.formularioEtiqueta}>Foto de la mascota *</Text>

            {fotoLocal && (
              <View style={styles.fotoElegidaContenedor}>
                <Image
                  source={{ uri: fotoLocal }}
                  style={styles.fotoElegidaImagen}
                  accessibilityLabel="Foto elegida para el reporte"
                />
                <TouchableOpacity
                  style={[styles.fotoElegidaQuitar, subiendo && { opacity: 0.5 }]}
                  onPress={() => setFotoLocal(null)}
                  disabled={subiendo}
                  accessibilityRole="button"
                  accessibilityLabel="Quitar foto elegida"
                  accessibilityHint="Quita la foto del formulario. Puedes elegir otra antes de guardar."
                >
                  <View style={styles.fotoElegidaQuitarCirculo}>
                    <Ico n="close" s={16} c="#fff" />
                  </View>
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.selectorRow}>
              <TouchableOpacity style={styles.opcionBoton} onPress={() => elegirFoto('camara')}>
                <IcoTexto n="camera-outline" s={17} c="#222" centrado textoStyle={styles.textoNegro}>Tomar foto</IcoTexto>
              </TouchableOpacity>
              <TouchableOpacity style={styles.opcionBoton} onPress={() => elegirFoto('galeria')}>
                <IcoTexto n="images-outline" s={17} c="#222" centrado textoStyle={styles.textoNegro}>Subir foto</IcoTexto>
              </TouchableOpacity>
            </View>

            <Text style={styles.formularioEtiqueta}>Nombre de la mascota o apodo *</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Nombre de la mascota o apodo (obligatorio)"
              maxLength={60}
              placeholder="Nombre de la mascota o apodo"
              value={nombre}
              onChangeText={setNombre}
            />
            <Text style={styles.formularioEtiqueta}>Raza (opcional)</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Raza (opcional)"
              maxLength={60}
              placeholder="Raza (Ej. Golden Retriever)"
              value={raza}
              onChangeText={setRaza}
            />

            <Text style={styles.formularioEtiqueta}>Tipo de reporte *</Text>
            <View style={styles.selectorRow}>
              <TouchableOpacity
                style={[styles.opcionBoton, tipo === 'Perdida' && styles.opcionActiva]}
                onPress={() => setTipo('Perdida')}
              >
                <IcoTexto n="alert-circle-outline" s={17} c={tipo === 'Perdida' ? '#fff' : '#e53935'} centrado textoStyle={tipo === 'Perdida' ? styles.textoBlanco : styles.textoNegro}>Perdida</IcoTexto>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.opcionBoton, tipo === 'Encontrada' && styles.opcionActiva]}
                onPress={() => setTipo('Encontrada')}
              >
                <IcoTexto n="checkmark-circle-outline" s={17} c={tipo === 'Encontrada' ? '#fff' : PRIMARY_DARK} centrado textoStyle={tipo === 'Encontrada' ? styles.textoBlanco : styles.textoNegro}>Encontrada</IcoTexto>
              </TouchableOpacity>
            </View>

            <Text style={styles.formularioEtiqueta}>Especie *</Text>
            <View style={styles.selectorRow}>
              {(['Perro', 'Gato', 'Otro'] as const).map((op) => (
                <TouchableOpacity
                  key={op}
                  style={[styles.opcionBoton, especie === op && styles.opcionActiva]}
                  onPress={() => {
                    setEspecie(op);
                    if (op === 'Otro') {
                      setEspecieTemporal(especieOtro);
                      setModalEspecieVisible(true);
                    } else {
                      setEspecieOtro('');
                    }
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={especie === op ? styles.textoBlanco : styles.textoNegro}
                  >
                    {op === 'Otro' && especieOtro ? `Otro: ${especieOtro}` : op}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {!editandoId && (
            <>
            <Text style={styles.formularioEtiqueta}>
              {tipo === 'Perdida' ? '¿Cuándo se perdió?' : '¿Cuándo la encontraste?'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {OPCIONES_CUANDO.map((o) => (
                <TouchableOpacity
                  key={o.id}
                  style={[
                    styles.formularioOpcionFecha,
                    opcionCuando === o.id && styles.opcionActiva,
                  ]}
                  onPress={() => setOpcionCuando(o.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: opcionCuando === o.id }}
                  accessibilityLabel={o.label}
                >
                  <Text style={[{ fontSize: 14, lineHeight: 20, textAlign: 'center' }, opcionCuando === o.id ? styles.textoBlanco : styles.textoNegro]}>{o.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            </>
            )}

            <Text style={styles.formularioEtiqueta}>Ubicación de la mascota *</Text>
            <TouchableOpacity
              style={[styles.opcionBoton, { marginBottom: 8, alignItems: 'center' }]}
              onPress={usarMiUbicacion}
              disabled={obteniendoUbicacion}
            >
              <IcoTexto
                n={coordsReporte ? 'checkmark-circle' : 'locate-outline'}
                s={17}
                c={coordsReporte ? '#2e7d32' : '#222'}
                centrado
                textoStyle={styles.textoNegro}
              >
                {obteniendoUbicacion
                  ? 'Obteniendo ubicación...'
                  : coordsReporte
                  ? 'Ubicación marcada (toca para actualizar)'
                  : 'Usar mi ubicación actual'}
              </IcoTexto>
            </TouchableOpacity>

            <Text style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
              {tipo === 'Perdida'
                ? 'Toca el mapa para marcar dónde se perdió'
                : 'Toca el mapa para marcar dónde la encontraste'}
            </Text>
            <View style={{ height: 220, borderRadius: 12, overflow: 'hidden', backgroundColor: '#eee', marginBottom: 6 }}>
              <VistaHtml html={selectorHtml} onMensaje={alRecibirPunto} />
            </View>
            <IcoTexto
              n={coordsReporte ? 'checkmark-circle' : 'information-circle-outline'}
              s={15}
              c={coordsReporte ? '#2e7d32' : '#6b6b6b'}
              estilo={{ marginBottom: 10 }}
              textoStyle={{ fontSize: 12, color: coordsReporte ? '#2e7d32' : '#6b6b6b' }}
            >
              {coordsReporte
                ? 'Punto marcado (puedes arrastrarlo para ajustarlo)'
                : 'Aún no has marcado ningún punto'}
            </IcoTexto>
            <Text style={styles.formularioEtiqueta}>Referencia de ubicación (opcional)</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Referencia de ubicación (opcional)"
              maxLength={150}
              placeholder="Ubicación (Ej. Col. Linda Vista)"
              value={ubicacion}
              onChangeText={setUbicacion}
            />
            <Text style={styles.formularioEtiqueta}>Descripción o señas particulares (opcional)</Text>
            <TextInput
              style={[styles.input, { minHeight: 88, textAlignVertical: 'top' }]}
              accessibilityLabel="Descripción o señas particulares (opcional)"
              maxLength={500}
              placeholder="Descripción corta o señas particulares"
              multiline
              value={descripcion}
              onChangeText={setDescripcion}
            />

            {tipo === 'Perdida' && (
              <>
                <View style={styles.selectorRow}>
                  <TouchableOpacity
                    style={[styles.opcionBoton, !hayRecompensa && styles.opcionActiva]}
                    onPress={() => setHayRecompensa(false)}
                  >
                    <Text style={!hayRecompensa ? styles.textoBlanco : styles.textoNegro}>Sin recompensa</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.opcionBoton, hayRecompensa && styles.opcionActiva]}
                    onPress={() => setHayRecompensa(true)}
                  >
                    <IcoTexto n="gift-outline" s={17} c={hayRecompensa ? '#fff' : '#222'} centrado textoStyle={hayRecompensa ? styles.textoBlanco : styles.textoNegro}>Ofrezco recompensa</IcoTexto>
                  </TouchableOpacity>
                </View>
                {hayRecompensa && (
                  <View>
                  <Text style={styles.formularioEtiqueta}>Monto o detalle de recompensa (opcional)</Text>
                  <TextInput
                    accessibilityLabel="Monto o detalle de recompensa, opcional"
                    style={styles.input}
                    placeholder="Monto o detalle (Ej. $500) — opcional"
                    value={recompensaTexto}
                    onChangeText={setRecompensaTexto}
                  />
                  </View>
                )}
              </>
            )}

            <Text style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
              Datos de contacto (se mostrarán a quien consulte el reporte)
            </Text>
            <Text style={styles.formularioEtiqueta}>Tu nombre *</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Tu nombre (obligatorio)"
              maxLength={60}
              placeholder="Tu nombre"
              value={contactoNombre}
              onChangeText={setContactoNombre}
            />
            <Text style={styles.formularioEtiqueta}>Teléfono / WhatsApp *</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel="Teléfono / WhatsApp (obligatorio)"
              placeholder="Teléfono / WhatsApp (10 dígitos)"
              keyboardType="phone-pad"
              maxLength={15}
              value={telefono}
              onChangeText={setTelefono}
            />

            <View style={styles.modalAcciones}>
              <TouchableOpacity
                style={styles.botonCancelar}
                onPress={cancelarReporte}
                disabled={subiendo}
                accessibilityRole="button"
                accessibilityLabel={editandoId ? 'Cancelar edición' : 'Cancelar reporte'}
              >
                <Text>{editandoId ? 'Cancelar edición' : 'Cancelar reporte'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.botonGuardar} onPress={guardarReporte} disabled={subiendo}>
                <Text style={styles.textoBlanco}>{subiendo ? 'Guardando...' : editandoId ? 'Guardar cambios' : 'Publicar'}</Text>
              </TouchableOpacity>
            </View>
            </ScrollView>
          </View>

          {/* Ventana pequeña: especificar la especie cuando se elige "Otro" */}
          <Modal visible={modalEspecieVisible} transparent animationType="fade">
            <View style={styles.modalOverlay}>
              <View style={[styles.modalContenido, { width: 320 }]}>
                <Text style={styles.modalTitulo}>¿Qué especie es?</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej. Conejo, Hámster, Loro..."
                  value={especieTemporal}
                  onChangeText={setEspecieTemporal}
                  autoFocus
                />
                <View style={styles.modalAcciones}>
                  <TouchableOpacity
                    style={styles.botonCancelar}
                    onPress={() => {
                      if (!especieOtro) setEspecie('Perro');
                      setModalEspecieVisible(false);
                    }}
                  >
                    <Text>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.botonGuardar}
                    onPress={() => {
                      if (!especieTemporal.trim()) {
                        avisar('Falta la especie', 'Escribe qué tipo de animal es.');
                        return;
                      }
                      setEspecieOtro(especieTemporal.trim());
                      setModalEspecieVisible(false);
                    }}
                  >
                    <Text style={styles.textoBlanco}>Aceptar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </Modal>

      {/* Pantalla de detalle de un reporte */}
      <Modal visible={detalleVisible} animationType="slide" transparent onRequestClose={() => setDetalleVisible(false)}>
        <SafeAreaView style={[styles.detalleFondo, { padding: anchoPantalla >= 700 ? 16 : 0 }]}>
          <View style={[styles.detallePanel, { borderRadius: anchoPantalla >= 700 ? 16 : 0 }]}>
          <View style={styles.detalleCabecera}>
            <Text accessibilityRole="header" style={{ flex: 1, fontSize: 18, fontWeight: '700', color: '#222' }}>Detalle del reporte</Text>
            <TouchableOpacity style={styles.detalleCerrar} onPress={() => setDetalleVisible(false)} accessibilityRole="button" accessibilityLabel="Cerrar detalle del reporte">
              <Ico n="close" s={24} c="#333" />
            </TouchableOpacity>
          </View>
          {mascotaDetalle && (
            <>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
                <View>
                  <Image source={{ uri: mascotaDetalle.foto }} style={[styles.detalleFoto, { height: Math.min(360, Math.max(220, anchoPantalla * 0.6)) }]} resizeMode="contain" accessibilityLabel={`Foto de ${mascotaDetalle.nombre}`} />
                </View>

                <View style={{ padding: 18 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={styles.detalleNombre}>{mascotaDetalle.nombre}</Text>
                    <View
                      style={[
                        styles.badge,
                        { backgroundColor: mascotaDetalle.tipo === 'Perdida' ? '#ffebee' : '#e8f5e9' },
                      ]}
                    >
                      <Text
                        style={{
                          color: mascotaDetalle.tipo === 'Perdida' ? '#c62828' : '#2e7d32',
                          fontWeight: 'bold',
                          fontSize: 11,
                        }}
                      >
                        {mascotaDetalle.tipo === 'Perdida' ? 'PERDIDO' : 'ENCONTRADO'}
                      </Text>
                    </View>
                  </View>

                  {mascotaDetalle.recompensa ? (
                    <View style={styles.detalleRecompensa}>
                      <IcoTexto n="gift" s={17} c="#8a5a00" textoStyle={{ color: '#8a5a00', fontWeight: 'bold' }}>
                        Recompensa{mascotaDetalle.recompensa !== 'Sí' ? `: ${mascotaDetalle.recompensa}` : ''}
                      </IcoTexto>
                    </View>
                  ) : null}

                  <View style={{ marginTop: 8 }}>
                    <FilaDetalle
                      icono="paw" mci
                      titulo="ESPECIE Y RAZA"
                      valor={`${
                        mascotaDetalle.especie === 'Otro' && mascotaDetalle.especieOtro
                          ? mascotaDetalle.especieOtro
                          : mascotaDetalle.especie
                      } · ${razaVisible(mascotaDetalle.raza)}`}
                    />
                    {mascotaDetalle.fechaEvento ? (
                      <FilaDetalle
                        icono="time-outline"
                        titulo={mascotaDetalle.tipo === 'Perdida' ? 'SE PERDIÓ' : 'SE ENCONTRÓ'}
                        valor={`${tiempoRelativo(mascotaDetalle.fechaEvento)} (${fechaCompleta(mascotaDetalle.fechaEvento)})`}
                      />
                    ) : null}
                    <FilaDetalle
                      icono="location-outline"
                      titulo="ZONA"
                      valor={`${mascotaDetalle.ubicacion}${
                        miUbicacion
                          ? ' · a ' +
                            formatoDistancia(
                              distanciaKm(miUbicacion.lat, miUbicacion.lng, mascotaDetalle.latitud, mascotaDetalle.longitud)
                            )
                          : ''
                      }`}
                    />
                    {mascotaDetalle.contactoNombre ? (
                      <FilaDetalle icono="person-outline" titulo="REPORTA" valor={mascotaDetalle.contactoNombre} />
                    ) : null}
                  </View>

                  {mascotaDetalle.descripcion ? (
                    <View style={{ marginTop: 10 }}>
                      <Text style={styles.detalleSeccion}>DESCRIPCIÓN</Text>
                      <Text style={{ fontSize: 14, color: '#333', lineHeight: 20 }}>{mascotaDetalle.descripcion}</Text>
                    </View>
                  ) : null}

                  <Text style={[styles.detalleSeccion, { marginTop: 16 }]}>UBICACIÓN EN EL MAPA</Text>
                  <View style={styles.detalleMapa}>
                    <VistaHtml
                      scrollEnabled={false}
                      html={generarMiniMapaHtml(
                        mascotaDetalle.latitud,
                        mascotaDetalle.longitud,
                        mascotaDetalle.tipo === 'Perdida' ? '#e53935' : PRIMARY_COLOR
                      )}
                    />
                  </View>
                </View>
              </ScrollView>

              {/* Barra de acciones fija abajo */}
              {mascotaDetalle.autorId && mascotaDetalle.autorId === auth.currentUser?.uid ? (
                <View style={[styles.detalleAcciones, { flexWrap: 'wrap' }]}>
                  {mascotaDetalle.estado !== 'Reunida' && (
                    <TouchableOpacity
                      style={[styles.detalleBoton, { backgroundColor: PRIMARY_DARK, flexBasis: '100%' }]}
                      onPress={() => marcarReunida(mascotaDetalle)}
                    >
                      <IcoTexto n="checkmark-circle" s={19} c="#fff" centrado textoStyle={styles.detalleBotonTexto}>
                        {mascotaDetalle.tipo === 'Perdida' ? '¡Ya regresó a casa!' : 'Ya la entregué a su dueño'}
                      </IcoTexto>
                    </TouchableOpacity>
                  )}
                  {mascotaDetalle.estado !== 'Reunida' && (
                    <TouchableOpacity
                      style={[styles.detalleBoton, { backgroundColor: '#555' }]}
                      onPress={() => abrirEdicion(mascotaDetalle)}
                    >
                      <IcoTexto n="create-outline" s={18} c="#fff" centrado textoStyle={styles.detalleBotonTexto}>Editar</IcoTexto>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.detalleBoton, { backgroundColor: '#d32f2f' }]}
                    onPress={() => eliminarReporte(mascotaDetalle)}
                  >
                    <IcoTexto n="trash-outline" s={18} c="#fff" centrado textoStyle={styles.detalleBotonTexto}>Eliminar</IcoTexto>
                  </TouchableOpacity>
                </View>
              ) : mascotaDetalle.telefono ? (
                <View style={styles.detalleAcciones}>
                  <TouchableOpacity
                    style={[styles.detalleBoton, { backgroundColor: '#555' }]}
                    onPress={() => contactar('llamar', mascotaDetalle)}
                  >
                    <IcoTexto n="call" s={18} c="#fff" centrado textoStyle={styles.detalleBotonTexto}>Llamar</IcoTexto>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.detalleBoton, { backgroundColor: '#1a7f37' }]}
                    onPress={() => contactar('whatsapp', mascotaDetalle)}
                  >
                    <IcoTexto n="logo-whatsapp" s={19} c="#fff" centrado textoStyle={styles.detalleBotonTexto}>WhatsApp</IcoTexto>
                  </TouchableOpacity>
                </View>
              ) : null}
            </>
          )}
          </View>
        </SafeAreaView>
      </Modal>

      {/* Modal: Resultados del escáner */}
      <Modal visible={resultadosVisible} animationType="slide" transparent onRequestClose={() => setResultadosVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContenido}>
            <Text style={styles.modalTitulo}>
              {estadoImagenEscaner === 'sin_mascota' ? 'No detectamos una mascota' : estadoImagenEscaner === 'no_clara' ? 'Prueba con una foto más clara' : 'Posibles coincidencias'}
            </Text>
            {coincidencias.length === 0 ? (
              <Text style={{ color: '#666', marginBottom: 12, lineHeight: 21 }}>
                {estadoImagenEscaner === 'sin_mascota'
                  ? 'No detectamos una mascota en esta imagen. Intenta con una foto donde se vea claramente al animal.'
                  : estadoImagenEscaner === 'no_clara'
                    ? 'No pudimos distinguir con claridad a la mascota. Intenta con una foto bien iluminada, enfocada y con un solo animal como sujeto principal.'
                    : comparados === 0
                      ? 'No hay reportes activos con fotos disponibles para comparar en esta búsqueda. Puedes publicar un reporte de mascota perdida o encontrada, según tu caso.'
                      : `${comparados !== null ? `No encontramos posibles coincidencias entre los ${comparados} reportes activos comparados.` : 'No encontramos posibles coincidencias.'} Puedes intentar con otra foto o publicar un reporte de mascota perdida o encontrada, según tu caso.`}
              </Text>
            ) : (
              coincidencias.map((c) => {
                const rep = reportes.find((r) => r.id === c.id);
                if (!rep) return null;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.tarjeta}
                    onPress={() => {
                      setResultadosVisible(false);
                      setTimeout(() => abrirDetalle(rep), Platform.OS === 'ios' ? 450 : 0);
                    }}
                  >
                    <Image source={{ uri: rep.foto }} style={styles.tarjetaFoto} />
                    <View style={styles.tarjetaInfo}>
                      <Text style={styles.tarjetaNombre}>
                        {rep.nombre} · {c.similitud}%
                      </Text>
                      <Text style={styles.tarjetaRaza}>{c.motivo}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
            <TouchableOpacity
              onPress={() => setResultadosVisible(false)}
              style={{ alignItems: 'center', marginTop: 8 }}
            >
              <Text style={{ color: '#666' }}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Indicador de carga mientras se analiza la foto */}
      {escaneando && (
        <View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
          }}
        >
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', textAlign: 'center', marginTop: 10 }}>Analizando foto…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Login
  contenedorLogin: {
    flex: 1,
    backgroundColor: PRIMARY_COLOR,
  },
  loginContenido: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  passwordFila: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, backgroundColor: '#f9f9f9', marginBottom: 12 },
  passwordCampo: { flex: 1, minWidth: 0, minHeight: 48, padding: 12, fontSize: 14, color: '#222', borderRadius: 8 },
  passwordBoton: { minHeight: 48, minWidth: 76, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', gap: 2 },
  passwordBotonTexto: { fontSize: 11, fontWeight: '600', color: PRIMARY_DARK },
  passwordAyuda: { padding: 10, backgroundColor: '#e6f8f1', borderRadius: 8, marginBottom: 12 },
  passwordAyudaTitulo: { fontSize: 13, fontWeight: '700', color: '#0b3d2e', marginBottom: 4 },
  passwordAyudaTexto: { fontSize: 13, lineHeight: 19, color: '#334b41' },
  tarjetaLogin: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 30,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 5,
  },
  logoLogin: { fontSize: 32, fontWeight: 'bold', color: PRIMARY_COLOR, marginBottom: 8 },
  subtituloLogin: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 24 },
  formContainer: { width: '100%' },
  labelInput: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6 },
  inputLogin: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    fontSize: 14,
  },
  botonIngresar: {
    backgroundColor: PRIMARY_DARK,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  textoBotonIngresar: { color: '#ffffff', fontWeight: 'bold', fontSize: 16 },

  // Dashboard
  contenedorPrincipal: { flex: 1, backgroundColor: '#f4f7f6' },

  navbar: {
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  navbarLogo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navbarLogoCirculo: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: PRIMARY_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navbarTitulo: { fontWeight: 'bold', fontSize: 15, color: '#222' },
  navbarSubtitulo: { fontSize: 8, color: '#6b6b6b', letterSpacing: 0.5 },
  navbarAcciones: { flexDirection: 'row', flexGrow: 0 },
  navbarBoton: {
    backgroundColor: '#e6f9f2',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    justifyContent: 'center',
  },
  navbarBotonTexto: { color: PRIMARY_DARK, fontWeight: '600', fontSize: 12 },
  navbarBotonSecundario: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    justifyContent: 'center',
  },
  navbarBotonSecundarioTexto: { color: '#555', fontWeight: '600', fontSize: 12 },
  navbarBotonReportar: {
    backgroundColor: PRIMARY_DARK,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    justifyContent: 'center',
  },
  navbarBotonReportarTexto: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
  navbarIconoBoton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f1f1',
  },
  badgeAviso: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#d32f2f',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeAvisoTexto: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  navbarBotonSalir: {
    backgroundColor: '#f1f1f1',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: 'center',
  },
  navbarBotonSalirTexto: { color: '#555', fontWeight: '600', fontSize: 12 },

  statusBar: {
    backgroundColor: PRIMARY_DARK,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  statusBarIzquierda: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  puntoActivo: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  statusBarTexto: { color: '#fff', fontSize: 12, fontWeight: '600' },
  statusBarDerecha: { flexDirection: 'row', gap: 16 },
  statusBarStat: { color: '#fff', fontSize: 12, fontWeight: '600' },

  contenido: { flex: 1 },

  panelFiltros: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  filtrosHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  filtrosTitulo: { fontWeight: 'bold', fontSize: 15, color: '#222' },
  filtrosLimpiar: { color: PRIMARY_DARK, fontWeight: '600', fontSize: 13 },
  filtrosLabel: { fontSize: 11, color: '#6b6b6b', fontWeight: '700', marginTop: 10, marginBottom: 6 },
  filtrosFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipFiltro: {
    borderWidth: 1,
    borderColor: '#ddd',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  chipFiltroActivo: { backgroundColor: PRIMARY_DARK, borderColor: PRIMARY_DARK },
  chipFiltroTexto: { color: '#555', fontSize: 12, fontWeight: '600' },
  chipFiltroTextoActivo: { color: '#fff' },
  buscador: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
  },

  tarjetaCuadro: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eee',
  },
  tarjetaVertical: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    overflow: 'hidden',
  },
  tarjetaFotoGrande: { width: '100%', aspectRatio: 1.6, backgroundColor: '#eef2ef' },
  reporteDatos: { padding: 14, gap: 5, minWidth: 0 },
  reporteNombre: { fontWeight: '700', fontSize: 20, lineHeight: 26, color: '#222' },
  reporteRaza: { fontSize: 15, lineHeight: 21, color: '#4b5563' },
  reporteMeta: { fontSize: 14, lineHeight: 20, color: '#555f5b' },
  navLink: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  navLinkActivo: { backgroundColor: '#e6f8f1' },
  navLinkTexto: { fontSize: 14, fontWeight: '600', color: '#555' },
  navLinkTextoActivo: { color: PRIMARY_DARK },
  navBotonPrincipal: {
    backgroundColor: PRIMARY_DARK,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
  },
  tarjeta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#eee',
  },
  tarjetaFoto: { width: 54, height: 54, borderRadius: 8, marginRight: 10, backgroundColor: '#eee' },
  tarjetaInfo: { flex: 1 },
  tarjetaNombre: { fontWeight: 'bold', fontSize: 14, color: '#222' },
  tarjetaRaza: { fontSize: 12, color: '#1565c0', marginTop: 1 },
  tarjetaUbicacion: { fontSize: 11, color: '#6b6b6b', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },

  leyenda: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  leyendaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  leyendaDot: { width: 10, height: 10, borderRadius: 5 },
  leyendaTexto: { fontSize: 12, color: '#666' },

  perfilPanel: { backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '92%', flexShrink: 1, overflow: 'hidden' },
  perfilCabecera: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e5ebe7' },
  perfilCuenta: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: '#edf6f0', borderRadius: 12, marginBottom: 22 },
  perfilNombre: { fontSize: 17, fontWeight: '700', color: '#22372b' },
  perfilTexto: { fontSize: 14, lineHeight: 21, color: '#59645d' },
  perfilPestanas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 },
  perfilPestana: { flexGrow: 1, paddingHorizontal: 10, paddingVertical: 13, borderRadius: 10, backgroundColor: '#edf3ef' },
  perfilPestanaActiva: { backgroundColor: PRIMARY_DARK },
  perfilVacio: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 10 },
  perfilReporte: { borderWidth: 1, borderColor: '#e1e8e3', borderRadius: 12, padding: 12, marginBottom: 12 },
  perfilAcciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  perfilAccion: { paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#f2f5f3', borderRadius: 8 },
  perfilAccionTexto: { fontSize: 14, fontWeight: '700', color: PRIMARY_DARK },
  perfilEnlace: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderWidth: 1, borderColor: '#dfe7e2', borderRadius: 10 },

  // Modales (reutilizados)
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContenido: { backgroundColor: '#fff', borderRadius: 12, padding: 20, width: '100%', maxWidth: 450 },
  modalTitulo: { fontSize: 18, fontWeight: 'bold', marginBottom: 15 },
  formularioCabecera: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12 },
  formularioCerrar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1f4f2' },
  avisoBorrador: { position: 'absolute', alignSelf: 'center', maxWidth: '90%', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: '#263c32', zIndex: 1000, elevation: 8 },
  avisoBorradorTexto: { color: '#fff', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  fotoElegidaContenedor: { width: 168, height: 168, alignSelf: 'center', marginBottom: 12, position: 'relative' },
  fotoElegidaImagen: { position: 'absolute', left: 0, bottom: 0, width: 144, height: 144, borderRadius: 12 },
  fotoElegidaQuitar: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  fotoElegidaQuitarCirculo: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#263c32', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  formularioEtiqueta: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 4 },
  formularioAyuda: { fontSize: 13, lineHeight: 19, color: '#555', marginBottom: 12 },
  formularioOpcionFecha: { flexGrow: 0, flexShrink: 0, minWidth: 88, minHeight: 44, paddingHorizontal: 12, paddingVertical: 11, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, marginBottom: 10 },
  selectorRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  opcionBoton: { flex: 1, padding: 10, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, alignItems: 'center' },
  opcionActiva: { backgroundColor: PRIMARY_DARK, borderColor: PRIMARY_DARK },
  textoBlanco: { color: '#fff', fontWeight: 'bold' },
  textoNegro: { color: '#333' },
  modalAcciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
  botonCancelar: { padding: 10 },
  botonGuardar: { backgroundColor: PRIMARY_DARK, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 6 },
  burbujaMensaje: { padding: 10, borderRadius: 8, marginBottom: 8, maxWidth: '80%' },
  burbujaPropia: { backgroundColor: '#d1f2d9', alignSelf: 'flex-end' },
  burbujaAjena: { backgroundColor: '#f1f1f1', alignSelf: 'flex-start' },
  textoMensaje: { fontSize: 13, color: '#333' },
  horaMensaje: { fontSize: 10, color: '#6b6b6b', textAlign: 'right', marginTop: 4 },
  barraControles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  barraInferior: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 6,
    paddingBottom: 8,
  },
  tabItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 4, gap: 2 },
  tabIcono: { fontSize: 20 },
  tabTexto: { fontSize: 11, color: '#6b6b6b', fontWeight: '600' },
  tabTextoActivo: { color: PRIMARY_DARK, fontWeight: '700' },
  tabReportar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: PRIMARY_DARK,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detalleFondo: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  detallePanel: { flex: 1, width: '100%', maxWidth: 900, backgroundColor: '#fff', overflow: 'hidden' },
  detalleCabecera: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: '#eee' },
  detalleFoto: { width: '100%', height: 300, backgroundColor: '#eef2ef' },
  detalleCerrar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#f1f4f2', alignItems: 'center', justifyContent: 'center',
  },
  detalleNombre: { fontSize: 26, fontWeight: 'bold', color: '#222', flex: 1, marginRight: 10 },
  detalleRecompensa: {
    backgroundColor: '#fff4d6',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 10,
    alignSelf: 'flex-start',
  },
  detalleSeccion: { fontSize: 11, color: '#6b6b6b', fontWeight: '700', marginBottom: 6 },
  detalleMapa: { height: 190, borderRadius: 12, overflow: 'hidden', backgroundColor: '#eee' },
  detalleAcciones: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
  },
  detalleBoton: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  detalleBotonTexto: { color: '#fff', fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
});