{
  description = "ORES event-driven GitHub review bots";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # nixos-unstable no longer evaluates x86_64-darwin. Keep the Intel macOS
  # development shell on the maintained Darwin branch instead of advertising
  # a system that cannot be instantiated.
  inputs.nixpkgsIntelDarwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs = { self, nixpkgs, nixpkgsIntelDarwin }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      nixpkgsFor = system: import (
        if system == "x86_64-darwin" then nixpkgsIntelDarwin else nixpkgs
      ) { inherit system; };
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (nixpkgsFor system));
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ nodejs_22 git just sops age jq kubectl ];
        };
      });
    };
}
