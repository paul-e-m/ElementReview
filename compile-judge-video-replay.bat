cd "P:\pCloud Sync\Data Specialist\Current ElementReview-dev"
dotnet publish .\JudgeVideoReplay\JudgeVideoReplay.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
