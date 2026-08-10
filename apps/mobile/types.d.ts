/** Metro отдаёт шрифты как модули-ассеты; TypeScript про это не знает. */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
