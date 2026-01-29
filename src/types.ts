export interface Env {
  CACHE: KVNamespace;
}

export interface ArtworkResponse {
  name: string;
  artist: string;
  albumId: string;
  static: string;
  animated: string | null;
  videoUrl: string | null;
}

export interface ErrorResponse {
  error: string;
}

export interface AppleMusicSearchResponse {
  results: {
    songs?: {
      data: AppleMusicTrack[];
    };
  };
}

export interface AppleMusicTrack {
  id: string;
  type: string;
  href: string;
  attributes: {
    albumName: string;
    artistName: string;
    name: string;
    url: string;
    durationInMillis: number;
    artwork?: {
      url: string;
      width: number;
      height: number;
    };
  };
  relationships?: {
    albums?: {
      data: Array<{ id: string; type: string }>;
    };
  };
}

export interface AppleMusicAlbumResponse {
  data: AppleMusicAlbum[];
}

export interface AppleMusicAlbum {
  id: string;
  type: string;
  attributes: {
    name: string;
    artistName: string;
    artwork: {
      url: string;
      width: number;
      height: number;
    };
    editorialVideo?: {
      motionDetailSquare?: {
        video: string;
      };
      motionSquareVideo1x1?: {
        video: string;
      };
    };
  };
}

export interface SearchResult {
  track: AppleMusicTrack;
  albumId: string;
  score: number;
}
