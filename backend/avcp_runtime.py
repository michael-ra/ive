"""Bundled AVCP subprocess entry, using the same scanner as source mode."""
import importlib.util
import json
import subprocess
import sys

from resource_path import project_root


def main(args=None):
    args=list(sys.argv[1:] if args is None else args)
    if len(args)!=3:
        raise ValueError("AVCP requires ecosystem, package and threshold")
    ecosystem,package,threshold=args
    path=project_root()/"anti-vibe-code-pwner/lib/scanner.py"
    spec=importlib.util.spec_from_file_location("avcp_scanner",path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Bundled AVCP scanner unavailable")
    scanner=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scanner)
    result=scanner.full_check(ecosystem,package,int(threshold))
    from hooks import _detect_install_scripts
    result["install_scripts"]=_detect_install_scripts(ecosystem,package,result,scanner,subprocess)
    print(json.dumps(result))
    return 0


if __name__=="__main__":raise SystemExit(main())
