export declare function generateRequestKey(config: Record<string, any>): string;
export declare function clearCache(): void;
export declare function createDedupeAdapter(axios: any): (config: any) => Promise<any>;
