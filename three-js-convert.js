function convertDOM(){
    var inputJson = JSON.parse($("#input").val());
    var filename = $("#filename").val() || "data";
    var result = convert(inputJson, filename);
    $("#outputJson").val(formatJson(result.json));
    $("#outputXml").val(result.xml)
    $("#outputXml2").val(result.xml2)
}

var BIT_MASK = {
    TRIANGLE: 0,
    QUAD: 1,
    FACE_MATERIAL: 2,
    FACE_UV: 4,
    FACE_VERTEX_UV: 8,
    FACE_NORMAL: 16,
    FACE_VERTEX_NORMAL: 32,
    FACE_COLOR: 64,
    FACE_VERTEX_COLOR: 128
}

var ArrayNumberPattern = /\s+\[[\s\d.\-e,]+\]/gi;

function formatJson(jsonData){
    var prettyString = JSON.stringify(jsonData, undefined, 2);
    var result = "";
    var res;
    var lastIdx = 0;
    while(res = ArrayNumberPattern.exec(prettyString)){
        var input = res[0];
        result += prettyString.substring(lastIdx, res.index);
        lastIdx = res.index + input.length;
        result += " " + input.replace(/\s/g, "");
    }
    result += prettyString.substring(lastIdx);
    return result;
}

function convert(inputJson, filename){

    var parsed = parse(inputJson);

    var indices = {}, attribs = {};

    convertFaces(indices, attribs, parsed, inputJson);

    var bindAttribs = {}, animations = {};

    convertAnimation(bindAttribs, animations, inputJson);

    var materials = inputJson.materials;

    // Fix potential material name conflicts:
    var usedMaterialNames = {};
    for(var i = 0; i < materials.length; ++i){
        materials[i].name = materials[i]["DbgName"];
        var idx = 2;
        while(usedMaterialNames[materials[i].name]){
            materials[i].name = materials[i]["DbgName"] + "_" + idx++;
        }
    }

    var json =  createJson(materials, indices, attribs, bindAttribs, animations, filename);

    var xml = createXml(materials, indices, attribs, bindAttribs, animations, filename);
    var xml2 = createXml2(materials, indices, attribs, bindAttribs, animations, filename);

    return { json: json, xml: xml, xml2: xml2};
}


function convertFaces(indices, attribs, parsed, inputJson)
{
    var vertexCache = {};

    initFaceAttribs(attribs, parsed, inputJson);

    var bonePerVertex = 0;
    if(inputJson['skinIndices'])
        bonePerVertex = inputJson['skinIndices'].length / (parsed.vertices.length);

    var resVertexCnt = 0;
    for(var faceIdx = 0; faceIdx < parsed.faces.length; ++faceIdx){
        var face = parsed.faces[faceIdx];

        var matIdx = face.material;
        indices[matIdx] = indices[matIdx] || [];

        var vertexCnt = face.positions.length;
        var realVertexIndices = [];

        for(var vertexIdx = 0; vertexIdx < vertexCnt; ++vertexIdx){
            var key = getVertexKey(face, vertexIdx);
            if(vertexCache[key] === undefined){
                addAttrib(attribs["position"], parsed.vertices, face.positions[vertexIdx], undefined, addFloat3);
                addAttrib(attribs["normal"], parsed.normals, face.vertexNormals[vertexIdx], face.normal, addFloat3);
                addAttrib(attribs["color"], parsed.colors, face.vertexColors[vertexIdx], face.color, addColor);

                for(var i = 0; i < parsed.uvs.length; ++i){
                    var texKey = getTexcoordName(i);
                    addAttrib(attribs[texKey], parsed.uvs[i], face.vertexUvs[i][vertexIdx], face.uvs[i], addFloat2);
                }

                addAttribFromJson(attribs["boneIdx"], inputJson['skinIndices'], face.positions[vertexIdx], 4, bonePerVertex);

                normalizeBoneWeights(inputJson['skinWeights'], face.positions[vertexIdx], bonePerVertex);
                addAttribFromJson(attribs["boneWeight"], inputJson['skinWeights'], face.positions[vertexIdx], 4, bonePerVertex);

                vertexCache[key] = resVertexCnt++;
            }
            realVertexIndices.push(vertexCache[key]);
        }
        addIndex( indices[matIdx], realVertexIndices, vertexCnt);
    }
    for(var i in attribs){
        if(!attribs[i].hasContent)
            delete attribs[i];
    }
}
function convertAnimation(bindAttribs, animations, inputJson)
{
    if(inputJson['bones']){
        bindAttribs['boneParent'] = {type: 'int', value: []};
        bindAttribs['bindTranslation'] = {type: 'float3', value: []};
        bindAttribs['bindRotation'] =  {type: 'float4', value: []};
        for(var i = 0; i < inputJson['bones'].length; ++i){
            var d = inputJson['bones'][i];
            addAttribFromJson(bindAttribs['boneParent'], [d['parent']], 0, 1, 1 );
            addAttribFromJson(bindAttribs['bindTranslation'], d['pos'], 0, 3, 3 );
            addAttribFromJson(bindAttribs['bindRotation'], d['rotq'], 0, 4, 4 );
        }
    }

    if(inputJson['animation']){
        var animName = inputJson['animation']['name'];
        animations[animName] = {};

        animations[animName]['maxKey'] = { type: 'float3', value: [ inputJson['animation']["length"] ]};
        var dest = animations[animName]["attribs"] = {};

        dest['translation']= [];
        dest['rotation']= [];

        // gather keys
        var keys = [];
        var boneData = inputJson['animation']['hierarchy'];
        var boneKeyIdx = [];
        for(var i = 0; i < boneData.length; ++i){
            for(var keyIdx = 0; keyIdx < boneData[i]['keys'].length; ++keyIdx){
                var time = boneData[i]['keys'][keyIdx]['time'];
                if(keys.indexOf(time) == -1 )
                    keys.push(time);
            }
            boneKeyIdx[i] = 0;
        }
        keys.sort();

        for(var keyIdx = 0; keyIdx < keys.length; ++keyIdx){
            var key = keys[keyIdx];
            var transEntry = {type: 'float3', value: [], key: key};
            var rotationEntry = {type: 'float4', value: [], key: key};
            for(var boneIdx = 0; boneIdx < boneData.length; ++boneIdx){
                var keyData = boneData[boneIdx]['keys'];
                var rotation, translation;

                var idx = boneKeyIdx[boneIdx];
                while( idx < keyData.length && keyData[idx]['time'] < key){
                    idx = ++boneKeyIdx[boneIdx];
                }

                if(idx >= keyData.length){
                    translation = keyData[keyData.length-1]['pos'];
                    rotation = keyData[keyData.length-1]['rot'];
                }
                else{

                    if(idx == 0){
                        translation = getPrevEntryWithValue(keyData, 'pos', idx)['pos'];
                        rotation = getPrevEntryWithValue(keyData, 'rot', idx)['rot'];
                    }
                    else{
                        var rot1 = getPrevEntryWithValue(keyData, 'rot', idx-1);
                        var rot2 = getNextEntryWithValue(keyData, 'rot', idx);
                        var rot_i = (key - rot1['time']) / (rot2['time'] - rot1['time']);
                        if(rot_i == 0)
                            rotation = rot1['rot'];
                        else if(rot_i == 1)
                            rotation = rot2['rot'];
                        else{
                            rotation = quat4.create();
                            quat4.slerp(rot1['rot'], rot2['rot'], rot_i, rotation);
                        }


                        var trans1 = getPrevEntryWithValue(keyData, 'pos', idx-1);
                        var trans2 = getNextEntryWithValue(keyData, 'pos', idx);
                        var trans_i = (key - trans1['time']) / (trans2['time'] - trans1['time']);
                        if(trans_i == 0)
                            translation = trans1['pos'];
                        else if(trans_i == 1)
                            translation = trans2['pos'];
                        else{
                            translation = vec3.create();
                            vec3.lerp(trans1['pos'], trans2['pos'], trans_i, translation);
                        }
                    }
                }
                addAttribFromJson(transEntry, translation, 0, 3, 3 );
                addAttribFromJson(rotationEntry, rotation, 0, 4, 4 );
            }
            dest['translation'].push(transEntry);
            dest['rotation'].push(rotationEntry);
        }
    }
}

function normalizeBoneWeights(weights, index, weightsPerVertex){
    var total = 0;
    for(var i=0; i < weightsPerVertex; ++i){
        total += weights[index*weightsPerVertex+i];
    }
    if(total > 0){
        for(var i=0; i < weightsPerVertex; ++i){
            weights[index*weightsPerVertex+i] /= total;
        }
    }

}

function getPrevEntryWithValue(keyData, propertyName, idx){
    while(!keyData[idx][propertyName]) idx--;
    return keyData[idx];
}
function getNextEntryWithValue(keyData, propertyName, idx){
    while(!keyData[idx][propertyName]) idx++;
    return keyData[idx];
}


function initFaceAttribs(attribs, parsed, inputJson){
    attribs["position"] = {type: 'float3', value: []};
    attribs["normal"] = {type: 'float3', value: []};
    attribs["color"] = {type: 'float3', value: []};
    for(var i = 0; i < parsed.uvs.length ; ++i){
        var texKey = getTexcoordName(i);
        attribs[texKey]= {type: 'float2', value: []};
    }
    attribs["boneIdx"] = {type: 'int4', value: []};
    attribs["boneWeight"] = {type: 'float4', value: []};
}

function addAttrib(dest, source, vertexIndex, faceIndex, addFunction){
    var idx = vertexIndex !== undefined ? vertexIndex : faceIndex;
    if(idx !== undefined){
        dest.hasContent = true;
        addFunction(dest.value, source[idx]);
    }
    else{
        addFunction(dest.value);
    }
}

function addAttribFromJson(dest, source, index, destCnt, srcCnt){
    if(source){
        dest.hasContent = true;
        for(var i = 0; i < destCnt; ++i){
            dest.value.push(i < srcCnt ? Math.round(source[index*srcCnt + i]*1000000) / 1000000 : 0);
        }
    }else{
        for(var i = 0; i < destCnt; ++i){
            dest.value.push(0);
        }
    }
}

function addIndex(targetIdx, realVertexIndices, vertexCnt){
    if(vertexCnt == 3){
        targetIdx.push(realVertexIndices[0]);
        targetIdx.push(realVertexIndices[1]);
        targetIdx.push(realVertexIndices[2]);
    }
    else if(vertexCnt == 4){
        targetIdx.push(realVertexIndices[0]);
        targetIdx.push(realVertexIndices[1]);
        targetIdx.push(realVertexIndices[2]);
        targetIdx.push(realVertexIndices[2]);
        targetIdx.push(realVertexIndices[3]);
        targetIdx.push(realVertexIndices[0]);
    }
    else{
        throw "Unsupported Vertex Count of " + vertexCnt;
    }
}

function getTexcoordName(i){
    return "texcoord" + (i ? "_" + (i+1) : '');
}

function addFloat2(dest, source){
    dest.push(source && source.u || 0);
    dest.push(source && source.v || 0);
}

function addFloat3(dest, source){
    dest.push(source && source.x || 0);
    dest.push(source && source.y || 0);
    dest.push(source && source.z || 0);
}

function addColor(dest, source){
    dest.push(source && source.r || 0);
    dest.push(source && source.g || 0);
    dest.push(source && source.b || 0);
}


function getVertexKey(face, vertexIdx){
    var normaIdx = face.vertexNormals[vertexIdx];
    if(normaIdx === undefined) normaIdx = face.normal;
    var colorIdx = face.vertexColors[vertexIdx];
    if(colorIdx === undefined) colorIdx = face.color;

    var result = face.positions[vertexIdx] + ";" + normaIdx + ";" + colorIdx;
    var i = face.vertexUvs.length;
    while(i--){
        if(face.vertexUvs[i].length){
            var uvIdx = face.vertexUvs[i][vertexIdx];
            if(uvIdx === undefined) uvIdx = face.uvs[i];
            result += ";" + uvIdx;
        }

    }
    return result;
}

function createJson(materials, indices, attribs, bindAttribs, animations){
    var jsonResult = {
        "format" : "xml3d-json",
        "version" : "0.4.0",
        "data" : {}
    };

    for(var mat in indices){
        var matName = materials[mat].name;
        jsonResult.data["index_" + matName] = {
            "type" : "int",
            "seq" : [ { "value" : indices[mat]}]
        }
    }
    for(var name in attribs){
        jsonResult.data[name] = {
            "type" : attribs[name].type,
            "seq" : [ { "value" : attribs[name].value}]
        }
    }
    for(var name in bindAttribs){
        jsonResult.data[name] = {
            "type" : bindAttribs[name].type,
            "seq" : [ { "value" : bindAttribs[name].value}]
        }
    }
    for(var aniName in animations){
        var aniAttribs = animations[aniName]["attribs"];
        for(var fieldName in aniAttribs){

            var entry = {
                "type" : aniAttribs[fieldName][0].type,
                "seq" : [ ]
            }
            for(var i = 0; i < aniAttribs[fieldName].length; ++i){
                entry['seq'].push(
                    { "value" : aniAttribs[fieldName][i].value ,
                        "key" : aniAttribs[fieldName][i].key} );
            }
            jsonResult.data[aniName + "_" + fieldName] = entry;
        }
    }

    return jsonResult;
}

function formatXml(xml) {
    var formatted = '';
    var reg = /(>)(<)(\/*)/g;
    xml = xml.replace(reg, '$1\r\n$2$3');
    var pad = 0;
    jQuery.each(xml.split('\r\n'), function(index, node) {
        var indent = 0;
        if (node.match( /.+<\/\w[^>]*>$/ )) {
            indent = 0;
        } else if (node.match( /^<\/\w/ )) {
            if (pad != 0) {
                pad -= 1;
            }
        } else if (node.match( /^<\w[^>]*[^\/]>.*$/ )) {
            indent = 1;
        } else {
            indent = 0;
        }

        var padding = '';
        for (var i = 0; i < pad; i++) {
            padding += '  ';
        }

        formatted += padding + node + '\r\n';
        pad += indent;
    });

    return formatted;
}


function createXml(materials, indices, attribs, bindAttribs, animations, filename)
{


    var doc = document.implementation.createDocument('http://www.xml3d.org/2009/xml3d','xml3d',null);
    var root = $(doc.documentElement);

    root.append($("<!-- \n\n Shaders \n\n -->"));
    for(var i = 0; i < materials.length; ++i){
        var material = materials[i];
        var shader = $(doc.createElement('shader'));
        shader.attr("script", "urn:xml3d:shader:phong");
        shader.attr("id", "shader_" + material.name);
        if(material["colorDiffuse"]){
            addXMLFloat3(doc, shader, "diffuseColor", material["colorDiffuse"]);
        }
        if(material["colorSpecular"]){
            addXMLFloat3(doc, shader, "specularColor", material["colorSpecular"]);
        }
        if(material["colorAmbient"]){
            addXMLFloat(doc, shader, "ambientIntensity", material["colorAmbient"][0]);
        }
        if(material["specularCoef"]){
            addXMLFloat(doc, shader, "shininess", material["specularCoef"] / 128);
        }
        if(material["transparency"]){
            addXMLFloat(doc, shader, "transparency", 1 - material["transparency"]);
        }
        if(material["mapDiffuse"]){
            addXMLTexture(doc, shader, "diffuseTexture", material["mapDiffuse"]);
        }
        root.append(shader);
    }

    root.append($("<!-- \n\n Mesh Base \n\n -->"));

    var base = $(doc.createElement('data'));
    base.attr("id", "meshbase");

    var jsonReference =   filename.split('/').pop() + ".json";

    var attribNames = [];
    for(var name in attribs){
        attribNames.push(name);
    }
    for(var name in bindAttribs){
        attribNames.push(name);
    }
    var filter = "keep(" + attribNames.join(", ") + ")";
    base.attr("filter", filter);
    base.attr("src", jsonReference);
    root.append(base);


    root.append($("<!-- \n\n Meshes \n\n -->"));


    for(var mat in indices){
        var matName = materials[mat].name;

        var mesh =  $(doc.createElement('data'));
        mesh.attr("id", "index_" + matName);
        mesh.attr("src", jsonReference);
        mesh.attr("filter", "keep( {index: " + "index_" + matName + "} )");

        root.append(mesh);
    }

    root.append($("<!-- \n\n Animations \n\n -->"));

    for(var animName in animations){

        var data =  $(doc.createElement('data'));
        data.attr("id",  "anim_" + animName);
        var subData = $(doc.createElement('data'));
        subData.attr("src", jsonReference);
        subData.attr("filter", "keep( {translation: " + animName + "_translation, rotation: " + animName + "_rotation } )");
        data.append(subData);
        var subFloat = $(doc.createElement('float'));
        subFloat.attr("name", "maxKey");
        subFloat.text(animations[animName]["maxKey"].value.join(" "));
        data.append(subFloat);
        root.append(data);
    }

    var xml = new XMLSerializer().serializeToString(doc);
    var formatted = formatXml(xml);
    formatted = formatted.replace(/<data ([^>]+)\/>/g, "<data $1 ></data>");

    return '<?xml version="1.0" encoding="UTF-8"?>' + "\n" + formatted;
}

function createXml2(materials, indices, attribs, bindAttribs, animations, filename)
{
    var doc = document.implementation.createDocument('http://www.xml3d.org/2009/xml3d','xml3d',null);
    var root = $(doc.documentElement);

    root.append($("<!-- \n\n Mesh instantiations \n\n -->"));
    for(var mat in indices){
        var matName = materials[mat].name;

        var group = $(doc.createElement('group'));
        group.attr("shader", filename + ".xml#shader_" + matName);

        var mesh = $(doc.createElement('mesh')).attr("type", "triangles");
        group.append(mesh);

        mesh.append($(doc.createElement('data')).attr("src",  filename + ".xml#meshbase"));
        mesh.append($(doc.createElement('data')).attr("src",  filename + ".xml#index_" + matName));

        root.append(group);
    }
    root.append($("<!-- \n\n Animation Base \n\n -->"));
    for(var animName in animations){

        var data = $(doc.createElement('data'));

        data.append($(doc.createElement('data')).attr("src", filename + ".xml#meshbase"));
        data.append($(doc.createElement('data')).attr("src", filename + ".xml#anim_" + animName));
        data.append($(doc.createElement('float')).attr("name", "key").text("0.0"));
        data.append($('<float/>', {name: "key"}).text("0.0"));

        root.append(data);
    }

    var xml = new XMLSerializer().serializeToString(doc);
    var formatted = formatXml(xml);
    formatted = formatted.replace(/<data ([^>]+)\/>/g, "<data $1 ></data>");

    return formatted;
}

function addXMLFloat(doc, dest, name, src){
    var node = $(doc.createElement('float'));
    node.attr("name", name);
    node.text(src);
    dest.append(node);
}

function addXMLFloat3(doc, dest, name, src){
    var node = $(doc.createElement('float3'));
    node.attr("name", name);
    node.text(src.join(" "));
    dest.append(node);
}
function addXMLTexture(doc, dest, name, src){
    var node = $(doc.createElement('texture'));
    node.attr("name", name);
    var img = $(doc.createElement('img'));
    img.attr("src", src);
    node.append(img);
    dest.append(node);
}


function parse( json) {

    if ( json.metadata === undefined || json.metadata.formatVersion === undefined || json.metadata.formatVersion !== 3.1 ) {

        console.error( 'Deprecated file format.' );
        return null;

    }

    function isBitSet( value, position ) {

        return value & ( 1 << position );

    };

    var i, j,

        offset, zLength,

        type,
        isQuad,
        hasMaterial,
        hasFaceUv, hasFaceVertexUv,
        hasFaceNormal, hasFaceVertexNormal,
        hasFaceColor, hasFaceVertexColor,

        vertex, face,

        faces = json.faces,
        vertices = json.vertices,
        normals = json.normals,
        colors = json.colors,
        uvs = json.uvs;

    var nUvLayers = 0;

    // disregard empty arrays


    nUvLayers = json.uvs.length;

    var result = {
        faces: [],
        vertices: [],
        normals: [],
        colors: [],
        uvs: []
    };

    offset = 0;
    zLength = vertices.length;

    while ( offset < zLength ) {

        vertex = {};

        vertex.x = vertices[ offset ++ ];
        vertex.y = vertices[ offset ++ ];
        vertex.z = vertices[ offset ++ ];

        result.vertices.push( vertex );
    }

    offset = 0;
    zLength = normals.length;

    while ( offset < zLength ) {

        var normal = {};

        normal.x = normals[ offset ++ ];
        normal.y = normals[ offset ++ ];
        normal.z = normals[ offset ++ ];

        result.normals.push( normal );
    }

    offset = 0;
    if(colors){
        zLength = colors.length;

        while ( offset < zLength ) {

            var color = {};

            color.r = colors[ offset ++ ];
            color.g = colors[ offset ++ ];
            color.b = colors[ offset ++ ];

            result.colors.push( color );
        }
    }

    for ( i = 0; i < nUvLayers; i++ ) {

        offset = 0;
        zLength = uvs[i].length;
        result.uvs[i] = [];

        while ( offset < zLength ) {

            var uv = {};

            uv.u = uvs[i][offset++];
            uv.v = uvs[i][offset++];

            result.uvs[i].push(uv);
        }

    }



    offset = 0;
    zLength = faces.length;

    while ( offset < zLength ) {

        type = faces[ offset ++ ];

        isQuad          	= isBitSet( type, 0 );
        hasMaterial         = isBitSet( type, 1 );
        hasFaceUv           = isBitSet( type, 2 );
        hasFaceVertexUv     = isBitSet( type, 3 );
        hasFaceNormal       = isBitSet( type, 4 );
        hasFaceVertexNormal = isBitSet( type, 5 );
        hasFaceColor	    = isBitSet( type, 6 );
        hasFaceVertexColor  = isBitSet( type, 7 );

        var nVertices;
        if ( isQuad ) {

            face = {type: "Face4"};
            face.positions = [];
            face.positions.push( faces[ offset ++ ]);
            face.positions.push( faces[ offset ++ ]);
            face.positions.push( faces[ offset ++ ]);
            face.positions.push( faces[ offset ++ ]);

            nVertices = 4;

        } else {

            face = {type: "Face3"};
            face.positions = [];
            face.positions.push( faces[ offset ++ ]);
            face.positions.push( faces[ offset ++ ]);
            face.positions.push(faces[ offset ++ ]);

            nVertices = 3;
        }

        face.vertexNormals = [];
        face.vertexColors = [];
        face.uvs = [];
        face.vertexUvs = [];
        for ( j = 0; j < nUvLayers; j ++ ) {
            face.vertexUvs[j] = [];
        }

        if ( hasMaterial ) {

            var materialIndex = faces[ offset ++ ];
            face.material = materialIndex;

        }

        if ( hasFaceUv ) {

            for ( i = 0; i < nUvLayers; i++ ) {

                var uvIndex = faces[ offset ++ ];

                face.uvs[i] = uvIndex;

            }

        }

        if ( hasFaceVertexUv ) {

            for ( i = 0; i < nUvLayers; i++ ) {

                for ( j = 0; j < nVertices; j ++ ) {

                    uvIndex = faces[ offset ++ ];

                    face.vertexUvs[i][j] = uvIndex;

                }
            }

        }

        if ( hasFaceNormal ) {

            var normalIndex = faces[ offset ++ ];

            face.normal = normalIndex;

        }

        if ( hasFaceVertexNormal ) {

            for ( i = 0; i < nVertices; i++ ) {

                var normalIndex = faces[ offset ++ ];
                face.vertexNormals.push( normalIndex );

            }

        }

        if ( hasFaceColor ) {

            face.color = faces[ offset ++ ];
        }

        if ( hasFaceVertexColor ) {

            for ( i = 0; i < nVertices; i++ ) {

                var colorIndex = faces[ offset ++ ];
                face.vertexColors.push( colorIndex );

            }

        }

        result.faces.push( face );

    }

    return result;

};